# File Vault — Chunked Uploader

A high-performance, responsive file & folder uploader built with HTML, CSS, JavaScript, and PHP,
styled as a "File Vault."

## Screens
 **Upload** (`#screen-upload`) — select files/folders or drag & drop; uploading starts immediately,
   no extra button press required.

## Core engine (unchanged contract)
- **Chunked uploads** in 2MB pieces so large files never time out.
- **Resume support** — `upload.php`'s `check` action reports which chunks already exist, so a retry
  picks up where it left off instead of re-sending the whole file.
- **Folder upload** via `webkitdirectory`, preserving relative paths on the server.
- **Concurrency** — up to 3 files upload at once; the rest wait their turn.
- **Security** — filenames and paths are sanitized; all file operations are confined to `uploads/`.

## UX signals implemented
- **Live drag feedback** — the drop zone's border and glow react the instant a file enters it, and the
  copy swaps to "Release to upload."
- **Honest progress** — every upload shows a real percentage plus live speed and time remaining,
  computed from actual bytes transferred.
- **Pause / Resume** — every in-progress file has its own Pause button; pausing stops it in place
  (progress kept) and Resume picks the same file back up from that exact chunk.
- **Inline retry** — if a chunk fails partway through, the item shows an inline "Retry" button that
  resumes from the same chunk instead of restarting.
- **Cancel** — drop a file from the queue entirely; its temp chunks are cleaned up server-side.
- **Rich upload preview** — once a file finishes, its row becomes a preview card: thumbnail (or a
  video/audio/pdf/archive icon), file type, size, image dimensions, and Replace / Remove actions.
- **Independent queue** — each file has its own row and its own progress; a "X of Y done" counter
  tracks overall completion and one file pausing/failing never blocks the others.
- **Clear** — once files finish, a Clear button next to the done counter sweeps the successful
  preview cards out of the list, leaving anything still uploading or paused in place.

## Setup
1. Extract the project to your web server (e.g., XAMPP's `htdocs/`, Apache, or nginx with PHP).
2. Ensure the `uploads/` and `temp/` directories are writable by the web server.
3. Open `index.html` in your browser.

## Requirements
- PHP 7.4+.
- Modern web browser (Chrome, Firefox, Edge, Safari).

## Files
- `index.html` — markup for both screens plus the upload-item / preview-card templates.
- `style.css` — the blue "File Vault" theme.
- `script.js` — screen navigation and the `Uploader` engine (select/drop, pause/resume/cancel,
  retry, previews, clear).
- `upload.php` — chunked upload/resume/cancel engine plus the `delete` action used by
  Remove/Clear/Replace.
