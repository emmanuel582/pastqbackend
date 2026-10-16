const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const defaultSettings = () => ({ enabled: false, mode: 'smart', time: '19:00', timezone: 'Africa/Lagos', days: [0, 1, 2, 3, 4, 5, 6], quietStart: '21:00', quietEnd: '08:00', personalized: true, pausedUntil: null });
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function validateSettings(input, previous = defaultSettings()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Provide reminder settings.');
  const value = { ...previous };
  for (const key of Object.keys(previous)) if (Object.hasOwn(input, key)) value[key] = input[key];
  if (typeof value.enabled !== 'boolean' || typeof value.personalized !== 'boolean' || !['smart', 'scheduled'].includes(value.mode)) invalid('Choose valid reminder options.');
  for (const key of ['time', 'quietStart', 'quietEnd']) if (typeof value[key] !== 'string' || !clockPattern.test(value[key])) invalid('Use a valid time.');
  if (value.quietStart === value.quietEnd) invalid('Quiet hours must have a different start and end.');
  if (value.mode === 'scheduled' && inQuietHours(minuteOf(value.time), value)) invalid('Choose a reminder time outside quiet hours.');
  if (typeof value.timezone !== 'string' || value.timezone.length > 100) invalid('Choose a valid time zone.');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format(); } catch { invalid('Choose a valid time zone.'); }
  if (!Array.isArray(value.days) || !value.days.length || value.days.length > 7 || value.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) invalid('Choose at least one study day.');
  value.days = [...new Set(value.days)].sort();
  if (value.pausedUntil !== null && (typeof value.pausedUntil !== 'string' || !Number.isFinite(Date.parse(value.pausedUntil)))) invalid('Choose a valid pause date.');
  return value;
}
export function localClock(date, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return { day, weekday: new Date(`${day}T12:00:00Z`).getUTCDay(), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
const minuteOf = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const inQuietHours = (minute, settings) => { const start = minuteOf(settings.quietStart), end = minuteOf(settings.quietEnd); return start < end ? minute >= start && minute < end : minute >= start || minute < end; };
export function studyTime(settings, activity) {
  let minute = minuteOf(settings.time);
  if (settings.mode === 'smart' && activity.length >= 3) {
    const recent = activity.slice(0, 20).map(item => localClock(new Date(Date.parse(item.at) - (item.durationSeconds || 0) * 1000), settings.timezone).minute).filter(value => !inQuietHours(value, settings)).sort((a, b) => a - b);
    if (recent.length >= 3) minute = Math.round(recent[Math.floor(recent.length / 2)] / 15) * 15 % 1440;
  }
  return inQuietHours(minute, settings) ? minuteOf(settings.quietEnd) : minute;
}
export function planReminder(settings, activity, now = new Date()) {
  const local = localClock(now, settings.timezone), target = studyTime(settings, activity);
  const studiedToday = activity.some(item => localClock(new Date(item.at), settings.timezone).day === local.day);
  const dates = new Set(activity.map(item => localClock(new Date(item.at), settings.timezone).day));
  let streak = 0;
  for (let offset = studiedToday ? 0 : 1; offset < 366; offset++) {
    const date = new Date(`${local.day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - offset);
    if (!dates.has(date.toISOString().slice(0, 10))) break;
    streak++;
  }
  const weakest = activity.filter(item => item.subject && item.total > 0).reduce((before, item) => !before || item.score / item.total < before.score / before.total ? item : before, null);
  const subject = settings.personalized ? weakest?.subject || activity.find(item => item.subject)?.subject || '' : '';
  const title = !settings.personalized ? 'A study moment with Scholar' : streak > 0 ? `A little practice keeps your ${streak}-day rhythm` : activity.length ? 'Scholar saved you a study moment' : 'Your first study moment';
  const body = subject ? `A short ${subject} session? Pick up where you left off.` : activity.length ? 'Come back for a short practice session. One step at a time.' : 'Start with a few questions. Scholar is here to help.';
  const due = settings.enabled && !(settings.pausedUntil && Date.parse(settings.pausedUntil) > now.getTime()) && settings.days.includes(local.weekday) && !studiedToday && !inQuietHours(local.minute, settings) && local.minute >= target && local.minute < Math.min(1440, target + 90);
  return { due, day: local.day, studiedToday, streak, targetTime: `${String(Math.floor(target / 60)).padStart(2, '0')}:${String(target % 60).padStart(2, '0')}`, title, body, subject, url: `/?reminder=study${subject ? `&subject=${encodeURIComponent(subject)}` : ''}` };
}
export function validateActivity(input, now = Date.now()) {
  if (!Array.isArray(input) || input.length > 100) invalid('Provide up to 100 study sessions.');
  return input.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[\w:.-]{1,180}$/.test(item.id)) invalid('A study session has an invalid ID.');
    const timestamp = Date.parse(item.at);
    if (!Number.isFinite(timestamp) || timestamp > now + 300000 || timestamp < now - 366 * 86400000) invalid('A study session has an invalid date.');
    if (!Number.isInteger(item.total) || item.total < 0 || item.total > 10000 || !Number.isInteger(item.score) || item.score < 0 || item.score > item.total) invalid('A study session has an invalid result.');
    if (item.subject != null && (typeof item.subject !== 'string' || item.subject.length > 100)) invalid('A study session has an invalid subject.');
    const durationSeconds = Number.isFinite(item.durationSeconds) ? Math.max(0, Math.min(86400, Math.floor(item.durationSeconds))) : 0;
    return { id: item.id, at: new Date(timestamp).toISOString(), score: item.score, total: item.total, subject: (item.subject || '').trim().replace(/[\x00-\x1f]/g, ''), durationSeconds };
  });
}
