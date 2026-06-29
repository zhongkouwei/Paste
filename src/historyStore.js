const fs = require('fs');
const path = require('path');

function sanitizeHistory(value, maxItems) {
  if (!Array.isArray(value)) {
    throw new Error('History file must contain an array');
  }

  return value
    .filter((item) => item && item.id && item.body)
    .slice(0, maxItems);
}

function backupPathFor(filePath, date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return `${filePath}.corrupt-${stamp}`;
}

function moveCorruptHistory(filePath) {
  const basePath = backupPathFor(filePath);
  let backupPath = basePath;
  let suffix = 1;

  while (fs.existsSync(backupPath)) {
    backupPath = `${basePath}-${suffix}`;
    suffix += 1;
  }

  fs.renameSync(filePath, backupPath);
  return backupPath;
}

function loadHistoryFile(filePath, maxItems) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return {
      history: sanitizeHistory(JSON.parse(raw), maxItems),
      corruptBackupPath: null
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { history: [], corruptBackupPath: null };
    }

    let corruptBackupPath = null;
    try {
      corruptBackupPath = moveCorruptHistory(filePath);
    } catch (backupError) {
      error.backupError = backupError;
    }

    return { history: [], corruptBackupPath, error };
  }
}

function saveHistoryFile(filePath, history) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(history, null, 2));
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup; preserve the original save failure.
    }
    throw error;
  }
}

module.exports = {
  loadHistoryFile,
  saveHistoryFile,
  sanitizeHistory
};
