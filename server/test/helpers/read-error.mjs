// Loaded only by the reader integration test. A marker lets the test switch
// one synthetic file from readable to EACCES without depending on OS ACLs.
import fs from 'node:fs';

const target = process.env.METEROAK_TEST_READ_ERROR_PATH;
const marker = process.env.METEROAK_TEST_READ_ERROR_MARKER;
const open = fs.openSync;

fs.openSync = function (file, ...options) {
  if (target && marker && String(file) === target && fs.existsSync(marker)) {
    throw Object.assign(new Error(`Synthetic read failure: ${target}`), {
      code: 'EACCES', syscall: 'open', path: target,
    });
  }
  return open.call(this, file, ...options);
};
