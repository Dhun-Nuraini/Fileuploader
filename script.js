/**
 * File Vault — Uploader Engine
 * Chunked uploads, resume, pause/cancel, folder support (server contract unchanged)
 * plus UX signals: live drag feedback, honest progress, inline retry,
 * rich upload previews, and an independent per-file queue.
 */

const CHUNK_SIZE = 1024 * 1024 * 2; // 2MB chunks
const MAX_CONCURRENT_UPLOADS = 3;

/* ---------------- helpers ---------------- */

function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 1) return '<1s';
    if (seconds < 60) return Math.ceil(seconds) + 's';
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
}

function extOf(name) {
    const parts = name.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

const ICONS = {
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="14" rx="2"/><path d="m22 8-6 4 6 4z"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 3v18M13 7h3M13 11h3M13 15h3"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>'
};

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif'];
const VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'flac', 'm4a'];
const ARCHIVE_EXT = ['zip', 'rar', '7z', 'tar', 'gz'];

function categoryOf(name) {
    const ext = extOf(name);
    if (ext === 'pdf') return 'pdf';
    if (IMAGE_EXT.includes(ext)) return 'image';
    if (VIDEO_EXT.includes(ext)) return 'video';
    if (AUDIO_EXT.includes(ext)) return 'audio';
    if (ARCHIVE_EXT.includes(ext)) return 'archive';
    return 'file';
}

function iconFor(name) {
    return ICONS[categoryOf(name)] || ICONS.file;
}

/* ---------------- Uploader ---------------- */

class Uploader {
    constructor() {
        this.queue = [];
        this.activeUploads = 0;
        this.doneCount = 0;

        this.fileInput = document.getElementById('fileInput');
        this.folderInput = document.getElementById('folderInput');
        this.dropZone = document.getElementById('dropZone');
        this.queueWrap = document.getElementById('queueWrap');
        this.uploadList = document.getElementById('uploadList');
        this.queueTotalEl = document.getElementById('queueTotal');
        this.queueTotal2El = document.getElementById('queueTotal2');
        this.queueDoneEl = document.getElementById('queueDone');
        this.clearDoneBtn = document.getElementById('clearDoneBtn');
        this.itemTemplate = document.getElementById('uploadItemTemplate');
        this.previewTemplate = document.getElementById('previewCardTemplate');

        this.init();
    }

    init() {
        // Selecting files/folders starts uploading immediately — no extra button press.
        this.fileInput.addEventListener('change', (e) => {
            this.handleFiles(e.target.files);
            e.target.value = '';
        });
        this.folderInput.addEventListener('change', (e) => {
            this.handleFiles(e.target.files);
            e.target.value = '';
        });

        let dragDepth = 0;
        this.dropZone.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragDepth++;
            this.dropZone.classList.add('dragover');
        });
        this.dropZone.addEventListener('dragover', (e) => e.preventDefault());
        this.dropZone.addEventListener('dragleave', () => {
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) this.dropZone.classList.remove('dragover');
        });
        this.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dragDepth = 0;
            this.dropZone.classList.remove('dragover');
            this.handleFiles(e.dataTransfer.files);
        });

        this.clearDoneBtn.addEventListener('click', () => this.clearCompleted());
    }

    handleFiles(files) {
        if (!files || files.length === 0) return;
        this.queueWrap.classList.remove('hidden');
        Array.from(files).forEach(file => {
            const item = this.createUploadItem(file);
            this.queue.push(item);
            this.resolveThenQueue(item);
        });
        this.updateQueueCounters();
    }

    /* ---- Split "folder/sub/name.ext" into a fixed dir prefix and an editable base name ---- */
    splitPath(path) {
        const idx = path.lastIndexOf('/');
        return idx === -1
            ? { dir: '', name: path }
            : { dir: path.substring(0, idx + 1), name: path.substring(idx + 1) };
    }

    createUploadItem(file) {
        const id = 'up_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
        const fullRelativePath = file.webkitRelativePath || file.name;
        const { dir, name } = this.splitPath(fullRelativePath);

        const clone = this.itemTemplate.content.cloneNode(true);
        const container = clone.querySelector('.upload-item');
        container.id = id;
        container.querySelector('.file-icon').innerHTML = iconFor(file.name);
        container.querySelector('.item-sub').textContent = formatBytes(file.size);

        this.uploadList.prepend(container);

        const item = {
            id, file, dir, name,
            relativePath: dir + name,
            overwrite: false,
            totalChunks: Math.ceil(file.size / CHUNK_SIZE) || 1,
            uploadedChunks: [],
            status: 'checking', // waiting | checking | conflict | uploading | completed | cancelled
            paused: false,
            cancelled: false,
            startTime: null,
            bytesAtStart: 0,
            dom: {
                container,
                nameEl: container.querySelector('.item-name'),
                percent: container.querySelector('.item-percent'),
                progressBar: container.querySelector('.progress-bar'),
                statRow: container.querySelector('.stat-row'),
                errorSlot: container.querySelector('.error-slot'),
                conflictSlot: container.querySelector('.conflict-slot'),
                pauseBtn: container.querySelector('.pause-btn'),
                resumeBtn: container.querySelector('.resume-btn'),
                cancelBtn: container.querySelector('.cancel-btn'),
                renameBtn: container.querySelector('.rename-btn'),
                renameRow: container.querySelector('.rename-row'),
                renameInput: container.querySelector('.rename-input'),
                renameSave: container.querySelector('.rename-save'),
                renameCancel: container.querySelector('.rename-cancel')
            }
        };

        this.renderName(item);

        item.dom.pauseBtn.onclick = () => this.pauseUpload(item);
        item.dom.resumeBtn.onclick = () => this.resumeUpload(item);
        item.dom.cancelBtn.onclick = () => this.cancelUpload(item);
        item.dom.renameBtn.onclick = () => this.openRename(item, false);
        item.dom.renameSave.onclick = () => this.saveRename(item);
        item.dom.renameCancel.onclick = () => this.closeRename(item);
        item.dom.renameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.saveRename(item); }
            if (e.key === 'Escape') this.closeRename(item);
        });

        return item;
    }

    renderName(item) {
        item.dom.nameEl.textContent = item.dir + item.name;
        item.dom.nameEl.title = item.dir + item.name;
    }

    /* ---- Feature: check whether a file with this name already exists on the server ---- */
    async checkExists(relativePath) {
        try {
            const formData = new FormData();
            formData.append('action', 'exists');
            formData.append('relativePath', relativePath);
            const res = await fetch('upload.php', { method: 'POST', body: formData }).then(r => r.json());
            return !!res.exists;
        } catch (e) {
            return false; // fail open — the server still guards against clobbering on write
        }
    }

    async resolveThenQueue(item) {
        const exists = await this.checkExists(item.relativePath);
        if (item.cancelled) return;
        if (exists) {
            this.showConflict(item);
        } else {
            item.status = 'waiting';
            this.updateQueueCounters();
            if (item.paused) {
                this.setPauseUiState(item, true);
            } else {
                this.processQueue();
            }
        }
    }

    showConflict(item) {
        item.status = 'conflict';
        item.dom.container.classList.add('conflict');
        item.dom.conflictSlot.innerHTML = `
            <div class="conflict-banner">
                <div>
                    <div class="conflict-text">"${item.name}" already exists</div>
                    <div class="conflict-sub">Rename it, keep both copies, or replace the existing file</div>
                </div>
                <div class="conflict-actions">
                    <button class="btn-small conflict-rename" type="button">Rename</button>
                    <button class="btn-small conflict-keep-both" type="button">Keep both</button>
                    <button class="btn-small danger conflict-replace" type="button">Replace</button>
                </div>
            </div>`;

        item.dom.conflictSlot.querySelector('.conflict-rename').onclick = () => {
            item.dom.conflictSlot.innerHTML = '';
            this.openRename(item, true);
        };
        item.dom.conflictSlot.querySelector('.conflict-keep-both').onclick = async () => {
            await this.autoDedupeName(item);
            this.clearConflict(item);
        };
        item.dom.conflictSlot.querySelector('.conflict-replace').onclick = () => {
            item.overwrite = true;
            this.clearConflict(item);
        };
    }

    clearConflict(item) {
        item.dom.conflictSlot.innerHTML = '';
        item.dom.container.classList.remove('conflict');
        item.status = 'waiting';
        this.updateQueueCounters();
        if (item.paused) {
            this.setPauseUiState(item, true);
        } else {
            this.processQueue();
        }
    }

    /* Find the next free "name (1).ext" style name */
    async autoDedupeName(item) {
        const dot = item.name.lastIndexOf('.');
        const base = dot > 0 ? item.name.substring(0, dot) : item.name;
        const ext = dot > 0 ? item.name.substring(dot) : '';
        let n = 1, candidate;
        do {
            candidate = `${base} (${n})${ext}`;
            n++;
        } while (n < 200 && await this.checkExists(item.dir + candidate));
        item.name = candidate;
        item.relativePath = item.dir + item.name;
        item.overwrite = false;
        this.renderName(item);
    }

    /* ---- Feature: rename the file before/while it's being sent ---- */
    openRename(item, fromConflict) {
        if (item.status === 'completed' || item.cancelled) return;
        item.dom.renameRow.classList.remove('hidden');
        item.dom.renameInput.value = item.name;
        item.dom.renameInput.dataset.wasConflict = fromConflict ? '1' : '0';
        item.dom.renameInput.focus();
        const dot = item.name.lastIndexOf('.');
        if (dot > 0) item.dom.renameInput.setSelectionRange(0, dot);
        else item.dom.renameInput.select();
    }

    closeRename(item) {
        const wasConflict = item.dom.renameInput.dataset.wasConflict === '1';
        item.dom.renameRow.classList.add('hidden');
        if (wasConflict && item.status === 'conflict') this.showConflict(item);
    }

    async saveRename(item) {
        const raw = item.dom.renameInput.value.trim();
        const wasConflict = item.dom.renameInput.dataset.wasConflict === '1';
        if (!raw) { this.closeRename(item); return; }
        // Filenames only — folder structure (item.dir) is preserved as-is
        const safeName = raw.replace(/[\/\\]/g, '').trim();
        if (!safeName) { this.closeRename(item); return; }

        item.dom.renameRow.classList.add('hidden');

        if (safeName === item.name) {
            if (wasConflict) this.showConflict(item);
            return;
        }

        item.name = safeName;
        item.relativePath = item.dir + item.name;
        item.overwrite = false;
        this.renderName(item);

        const exists = await this.checkExists(item.relativePath);
        if (exists) {
            this.showConflict(item);
        } else if (item.status === 'conflict' || item.status === 'checking') {
            this.clearConflict(item);
        }
    }

    updateQueueCounters() {
        const total = this.queue.length;
        this.queueTotalEl.textContent = total;
        this.queueTotal2El.textContent = total;
        this.queueDoneEl.textContent = this.doneCount;
        this.clearDoneBtn.disabled = this.doneCount === 0;
    }

    async processQueue() {
        if (this.activeUploads >= MAX_CONCURRENT_UPLOADS) return;
        const nextItem = this.queue.find(item => item.status === 'waiting' && !item.paused);
        if (nextItem) {
            nextItem.status = 'uploading';
            this.activeUploads++;
            await this.startUpload(nextItem);
            this.activeUploads--;
            this.processQueue();
        }
    }

    /* ---- Signal: independent queue — one failure/pause never blocks the others ---- */
    async startUpload(item) {
        item.dom.errorSlot.innerHTML = '';
        item.dom.container.classList.remove('error');
        item.startTime = Date.now();
        this.setPauseUiState(item, false);

        try {
            const checkResponse = await this.serverAction(item, 'check');
            item.uploadedChunks = checkResponse.uploadedChunks || [];
            item.bytesAtStart = item.uploadedChunks.length * CHUNK_SIZE;
            this.updateProgress(item);

            for (let i = 0; i < item.totalChunks; i++) {
                if (item.cancelled) { item.status = 'cancelled'; return; }
                if (item.paused) { item.status = 'waiting'; this.setPauseUiState(item, true); return; }
                if (item.uploadedChunks.includes(i)) continue;

                const chunk = item.file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                const formData = new FormData();
                formData.append('action', 'upload');
                formData.append('fileId', item.id);
                formData.append('fileName', item.name);
                formData.append('relativePath', item.relativePath);
                formData.append('overwrite', item.overwrite ? '1' : '0');
                formData.append('chunkIndex', i);
                formData.append('totalChunks', item.totalChunks);
                formData.append('file', chunk);

                const res = await fetch('upload.php', { method: 'POST', body: formData });
                if (!res.ok) throw new Error('Server returned ' + res.status);
                const result = await res.json();
                if (result.error) throw new Error(result.error);

                item.uploadedChunks.push(i);
                this.updateProgress(item);

                if (result.status === 'completed') {
                    this.completeUpload(item, result.fileName);
                    return;
                }
            }
        } catch (error) {
            if (!item.cancelled) this.showError(item, error.message || 'Connection lost');
        }
    }

    async serverAction(item, action, extra) {
        const formData = new FormData();
        formData.append('action', action);
        formData.append('fileId', item.id);
        formData.append('fileName', item.name || item.file.name);
        formData.append('relativePath', item.relativePath);
        if (extra) Object.keys(extra).forEach(k => formData.append(k, extra[k]));
        return fetch('upload.php', { method: 'POST', body: formData }).then(res => res.json());
    }

    /* ---- Signal: pause / resume mid-upload ---- */
    setPauseUiState(item, isPaused) {
        item.dom.pauseBtn.classList.toggle('hidden', isPaused);
        item.dom.resumeBtn.classList.toggle('hidden', !isPaused);
        item.dom.container.classList.toggle('paused', isPaused);
        if (isPaused) {
            item.dom.statRow.innerHTML = '<span class="stat-chip">Paused</span>';
        }
    }

    pauseUpload(item) {
        if (item.status === 'completed' || item.cancelled) return;
        item.paused = true;
        // If it's still queued (not actively uploading yet), reflect the paused state right away.
        if (item.status === 'waiting') this.setPauseUiState(item, true);
    }

    resumeUpload(item) {
        item.paused = false;
        item.status = 'waiting';
        this.setPauseUiState(item, false);
        this.processQueue();
    }

    async cancelUpload(item) {
        item.cancelled = true;
        item.paused = false;
        await this.serverAction(item, 'cancel');
        item.dom.container.remove();
        this.queue = this.queue.filter(q => q.id !== item.id);
        this.updateQueueCounters();
        this.processQueue();
    }

    /* ---- Signal: honest progress — real percent, time left, speed ---- */
    updateProgress(item) {
        const percent = item.totalChunks === 0 ? 100 : Math.round((item.uploadedChunks.length / item.totalChunks) * 100);
        item.dom.percent.textContent = percent + '%';
        item.dom.progressBar.style.width = percent + '%';

        const bytesUploaded = item.uploadedChunks.length * CHUNK_SIZE;
        const elapsed = (Date.now() - item.startTime) / 1000;
        const bytesThisSession = Math.max(0, bytesUploaded - item.bytesAtStart);
        const speed = elapsed > 0.3 ? bytesThisSession / elapsed : 0;
        const remainingBytes = Math.max(0, item.file.size - bytesUploaded);
        const eta = speed > 0 ? remainingBytes / speed : Infinity;

        const chips = [];
        if (speed > 0) chips.push(`${formatBytes(speed)}/s`);
        if (isFinite(eta)) chips.push(`${formatTime(eta)} left`);
        item.dom.statRow.innerHTML = chips.map(c => `<span class="stat-chip">${c}</span>`).join('');
    }

    /* ---- Signal: inline retry — dies at 90%, resumes at 90% ---- */
    showError(item, message) {
        item.status = 'waiting';
        item.dom.container.classList.add('error');
        item.dom.errorSlot.innerHTML = `
            <div class="error-banner">
                <div>
                    <div class="error-text">Upload failed</div>
                    <div class="error-sub">${message}</div>
                </div>
                <button class="btn-small retry">Retry</button>
            </div>`;
        item.dom.errorSlot.querySelector('.retry').onclick = () => {
            item.dom.container.classList.remove('error');
            item.dom.errorSlot.innerHTML = '';
            item.paused = false;
            item.status = 'waiting';
            this.processQueue();
        };
    }

    /* ---- Signal: rich preview on completion ---- */
    async completeUpload(item, finalName) {
        item.status = 'completed';
        this.doneCount++;
        this.updateQueueCounters();

        const clone = this.previewTemplate.content.cloneNode(true);
        const card = clone.querySelector('.preview-card');
        card.id = item.id;
        card.dataset.finalName = finalName;
        card.dataset.relativeDir = item.relativePath.includes('/')
            ? item.relativePath.substring(0, item.relativePath.lastIndexOf('/') + 1) : '';

        card.querySelector('.preview-name').textContent = finalName;
        card.querySelector('.badge-type').textContent = extOf(finalName) || categoryOf(finalName);
        card.querySelector('.badge-size').textContent = formatBytes(item.file.size);

        const thumb = card.querySelector('.preview-thumb');
        const category = categoryOf(item.file.name);
        if (category === 'image') {
            const url = URL.createObjectURL(item.file);
            const img = document.createElement('img');
            img.src = url;
            img.onload = () => {
                const dims = document.createElement('span');
                dims.className = 'preview-dims';
                dims.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
                thumb.appendChild(dims);
            };
            thumb.appendChild(img);
        } else if (category === 'video') {
            const url = URL.createObjectURL(item.file);
            const vid = document.createElement('video');
            vid.src = url; vid.muted = true; vid.currentTime = 0.5;
            thumb.appendChild(vid);
        } else {
            thumb.innerHTML = iconFor(item.file.name);
        }

        card.querySelector('.replace-btn').onclick = () => this.replaceFile(item, card);
        card.querySelector('.remove-btn').onclick = () => this.removeUploaded(card);

        item.dom.container.replaceWith(card);
        item.dom.container = card;
    }

    async removeUploaded(card) {
        const finalName = card.dataset.finalName;
        const relDir = card.dataset.relativeDir || '';
        card.style.opacity = '0.4';
        const formData = new FormData();
        formData.append('action', 'delete');
        formData.append('relativePath', relDir + finalName);
        try {
            const res = await fetch('upload.php', { method: 'POST', body: formData }).then(r => r.json());
            if (res.status === 'deleted' || res.status === 'success') {
                const id = card.id;
                this.queue = this.queue.filter(q => q.id !== id);
                card.remove();
                this.doneCount = Math.max(0, this.doneCount - 1);
                this.updateQueueCounters();
            } else {
                card.style.opacity = '1';
            }
        } catch (e) {
            card.style.opacity = '1';
        }
    }

    replaceFile(item, card) {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async () => {
            if (!input.files[0]) return;
            await this.removeUploaded(card);
            this.handleFiles(input.files);
        };
        input.click();
    }

    /* ---- Clear the successfully-uploaded cards out of the list ---- */
    clearCompleted() {
        this.queue = this.queue.filter(item => {
            if (item.status === 'completed') {
                item.dom.container.remove();
                return false;
            }
            return true;
        });
        this.doneCount = 0;
        this.updateQueueCounters();
        if (this.queue.length === 0) this.queueWrap.classList.add('hidden');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.uploader = new Uploader();
});
