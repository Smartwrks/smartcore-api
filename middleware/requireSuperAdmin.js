/**
 * Middleware: gate to platform super_admin only.
 *
 * MUST be mounted AFTER requireAccountAccess so req.role is populated.
 * Returns 403 if the caller is not a super_admin.
 */
export default function requireSuperAdmin(req, res, next) {
  if (req.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}
