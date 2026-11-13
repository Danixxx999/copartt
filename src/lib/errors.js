'use strict';
class AppError extends Error {
  constructor(status, message, { code, fields } = {}) { super(message); this.status = status; this.code = code; this.fields = fields; }
}
const bad = (msg, extra) => new AppError(400, msg, extra);
const unauthorized = (msg = 'Please sign in to continue.') => new AppError(401, msg, { code: 'UNAUTHENTICATED' });
const forbidden = (msg = 'You do not have permission to perform this action.') => new AppError(403, msg, { code: 'FORBIDDEN' });
const notFound = (msg = 'Not found.') => new AppError(404, msg, { code: 'NOT_FOUND' });
const conflict = (msg, code = 'CONFLICT') => new AppError(409, msg, { code });
function ensure(cond, err) { if (!cond) throw err; }
module.exports = { AppError, bad, unauthorized, forbidden, notFound, conflict, ensure };
