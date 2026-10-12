// A ordem importa: o UA do Edge contém "Chrome" e "Safari"; o do Chrome contém "Safari"; bots imitam o Chrome.
export function detectBrowser(userAgent: string): string {
  if (!userAgent) return 'unknown';
  if (/bot|crawler|spider/i.test(userAgent)) return 'bot';
  if (/^curl\//i.test(userAgent)) return 'curl';
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/OPR\//.test(userAgent)) return 'Opera';
  if (/Firefox\//.test(userAgent)) return 'Firefox';
  if (/Chrome\//.test(userAgent)) return 'Chrome';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return 'other';
}
