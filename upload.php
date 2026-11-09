<?php
/**
 * File Vault Backend
 * Chunking, Resume, Cancel, Security, Folder Structure, and deleting an
 * uploaded/completed file (delete).
 */

header('Content-Type: application/json');

$uploadDir = __DIR__ . DIRECTORY_SEPARATOR . 'uploads' . DIRECTORY_SEPARATOR;
$tempDir = __DIR__ . DIRECTORY_SEPARATOR . 'temp' . DIRECTORY_SEPARATOR;

// Ensure directories exist
if (!is_dir($uploadDir)) mkdir($uploadDir, 0777, true);
if (!is_dir($tempDir)) mkdir($tempDir, 0777, true);

/**
 * Security: Sanitize filename and path
 */
function sanitizePath($path) {
    // Remove directory traversal attempts
    $path = str_replace(['../', '..\\'], '', $path);
    // Remove leading/trailing slashes
    return trim($path, DIRECTORY_SEPARATOR . '/');
}

function sanitizeFilename($filename) {
    return preg_replace('/[^a-zA-Z0-9._-]/', '_', $filename);
}

$action = $_POST['action'] ?? 'upload';

if ($action === 'exists') {
    // Check whether a file already exists at the given relative path
    $relativePath = sanitizePath($_POST['relativePath'] ?? '');
    if (empty($relativePath)) {
        echo json_encode(['error' => 'Missing file path.']);
        exit;
    }
    $target = $uploadDir . $relativePath;
    $targetDir = dirname($target);
    $exists = false;
    if (is_dir($targetDir)) {
        $resolvedDir = realpath($targetDir);
        $uploadRoot = realpath($uploadDir);
        if ($resolvedDir !== false && $uploadRoot !== false && strpos($resolvedDir, $uploadRoot) === 0) {
            $exists = file_exists($target);
        }
    }
    echo json_encode(['status' => 'success', 'exists' => $exists]);
    exit;
}

if ($action === 'delete') {
    $relativePath = sanitizePath($_POST['relativePath'] ?? '');
    if (empty($relativePath)) {
        echo json_encode(['error' => 'Missing file path.']);
        exit;
    }
    $target = realpath($uploadDir . $relativePath);
    $uploadRoot = realpath($uploadDir);
    if ($target === false || strpos($target, $uploadRoot) !== 0) {
        echo json_encode(['error' => 'Invalid file path.']);
        exit;
    }
    if (is_file($target) && unlink($target)) {
        echo json_encode(['status' => 'deleted']);
    } else {
        echo json_encode(['error' => 'Could not delete file.']);
    }
    exit;
}

/* ============ Chunked upload engine (original contract) ============ */

$fileId = $_POST['fileId'] ?? ''; // Unique ID for the upload session
$fileName = $_POST['fileName'] ?? '';
$relativePath = $_POST['relativePath'] ?? ''; // For folder structure

if (empty($fileId) || empty($fileName)) {
    echo json_encode(['error' => 'Missing file information']);
    exit;
}

$safeFileName = sanitizeFilename($fileName);
$safeRelativePath = sanitizePath($relativePath);
$sessionDir = $tempDir . $fileId;

switch ($action) {
    case 'check':
        // Check which chunks are already uploaded
        $uploadedChunks = [];
        if (is_dir($sessionDir)) {
            $files = scandir($sessionDir);
            foreach ($files as $file) {
                if (strpos($file, 'chunk_') === 0) {
                    $uploadedChunks[] = (int)str_replace('chunk_', '', $file);
                }
            }
        }
        echo json_encode(['status' => 'success', 'uploadedChunks' => $uploadedChunks]);
        break;

    case 'upload':
        $chunkIndex = isset($_POST['chunkIndex']) ? (int)$_POST['chunkIndex'] : 0;
        $totalChunks = isset($_POST['totalChunks']) ? (int)$_POST['totalChunks'] : 1;

        if (!is_dir($sessionDir)) mkdir($sessionDir, 0777, true);

        $chunkFile = $sessionDir . DIRECTORY_SEPARATOR . 'chunk_' . $chunkIndex;

        if (isset($_FILES['file'])) {
            if (move_uploaded_file($_FILES['file']['tmp_name'], $chunkFile)) {
                // Check if all chunks are present
                $chunksPresent = 0;
                for ($i = 0; $i < $totalChunks; $i++) {
                    if (file_exists($sessionDir . DIRECTORY_SEPARATOR . 'chunk_' . $i)) {
                        $chunksPresent++;
                    }
                }

                if ($chunksPresent === $totalChunks) {
                    // Assemble file
                    $finalPath = $uploadDir . $safeRelativePath;
                    $finalDir = dirname($finalPath);
                    if (!is_dir($finalDir)) mkdir($finalDir, 0777, true);

                    // Handle duplicate filename
                    $overwrite = ($_POST['overwrite'] ?? '') === '1';
                    if (file_exists($finalPath)) {
                        if ($overwrite) {
                            // User explicitly confirmed replacing the existing file
                            @unlink($finalPath);
                        } else {
                            $pathInfo = pathinfo($finalPath);
                            $finalPath = $pathInfo['dirname'] . DIRECTORY_SEPARATOR . $pathInfo['filename'] . '_' . time() . '.' . ($pathInfo['extension'] ?? '');
                        }
                    }

                    $out = fopen($finalPath, "wb");
                    if ($out) {
                        for ($i = 0; $i < $totalChunks; $i++) {
                            $chunkPath = $sessionDir . DIRECTORY_SEPARATOR . 'chunk_' . $i;
                            $in = fopen($chunkPath, "rb");
                            while ($buff = fread($in, 4096)) {
                                fwrite($out, $buff);
                            }
                            fclose($in);
                            unlink($chunkPath); // Delete chunk after assembly
                        }
                        fclose($out);
                        rmdir($sessionDir); // Remove session dir
                        echo json_encode(['status' => 'completed', 'fileName' => basename($finalPath)]);
                    } else {
                        echo json_encode(['error' => 'Failed to open final file for writing']);
                    }
                } else {
                    echo json_encode(['status' => 'chunk_saved', 'chunkIndex' => $chunkIndex]);
                }
            } else {
                echo json_encode(['error' => 'Failed to save chunk']);
            }
        }
        break;

    case 'cancel':
        // Cleanup session directory
        if (is_dir($sessionDir)) {
            $files = array_diff(scandir($sessionDir), array('.', '..'));
            foreach ($files as $file) {
                unlink($sessionDir . DIRECTORY_SEPARATOR . $file);
            }
            rmdir($sessionDir);
        }
        echo json_encode(['status' => 'cancelled']);
        break;

    default:
        echo json_encode(['error' => 'Invalid action']);
        break;
}
