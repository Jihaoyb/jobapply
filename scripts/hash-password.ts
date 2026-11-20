import { hashPassword } from '../src/server/auth.js';
// Read stdin instead of exposing a password in process arguments/history.
let value = '';
for await (const chunk of process.stdin) value += chunk;
console.log(hashPassword(value.trimEnd()));
