import { z } from 'zod';
export const passwordPolicyHint = 'At least 10 characters, with upper and lower case letters and a digit.';
export const passwordInput = z.strictObject({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(10).max(128).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/),
}).refine(input => input.currentPassword !== input.newPassword, { message: 'Choose a different password.', path: ['newPassword'] });
