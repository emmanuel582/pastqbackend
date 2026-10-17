const moods = new Set(['welcome', 'focus', 'celebrate']);
export function reminderArtwork(mood) {
  const expression = moods.has(mood) ? mood : 'welcome';
  return { mood: expression, icon: `/pets/scholar/reminders/${expression}-icon-v1.png`, image: `/pets/scholar/reminders/${expression}-v1.jpg` };
}
