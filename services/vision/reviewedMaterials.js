/** Reviewed uploads stay private to their extraction owner, outside the shared catalog. */
export function reviewedMaterial(session, { summary = false } = {}) {
  return {
    id: session.id, sourceSessionId: session.id, title: session.name, name: session.name,
    icon: session.icon, approvedAt: session.approvedAt, updatedAt: session.updatedAt,
    question_count: session.questions.length, groups: session.groups || [],
    ...(summary ? {} : { questions: session.questions }),
  };
}

export function reviewQuestions(session, incoming) {
  if (!['completed', 'completed_with_errors'].includes(session.status)) {
    throw Object.assign(new Error('Wait for extraction to finish before saving.'), { status: 409 });
  }
  if (!Array.isArray(incoming) || !incoming.length || incoming.length !== session.questions.length) {
    throw Object.assign(new Error('Save all extracted questions together.'), { status: 400 });
  }
  const original = new Map(session.questions.map(question => [String(question.id), question]));
  const seen = new Set();
  return incoming.map(edit => {
    const id = String(edit?.id);
    const source = original.get(id);
    const fail = () => { throw Object.assign(new Error('Check the question text, options and answer key before saving.'), { status: 400 }); };
    if (!source || seen.has(id)) fail();
    seen.add(id);
    if (typeof edit.question !== 'string' || !edit.question.trim() || edit.question.length > 50000) fail();
    const minimumOptions = source.type && !['single_choice', 'multiple_choice', 'true_false'].includes(source.type) ? 0 : 2;
    if (!Array.isArray(edit.options) || edit.options.length < minimumOptions || edit.options.length > 12 ||
      edit.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 20000)) fail();
    if (edit.correct != null && (!Number.isInteger(edit.correct) || edit.correct < 0 || edit.correct >= edit.options.length)) fail();
    for (const field of ['subject', 'year', 'explanation']) {
      if (edit[field] != null && (typeof edit[field] !== 'string' || edit[field].length > (field === 'explanation' ? 50000 : 300))) fail();
    }
    // Keep source figures, provenance and identity; the browser cannot inject paths or metadata.
    return { ...source, question: edit.question.trim(), options: edit.options.map(option => option.trim()),
      correct: edit.correct ?? null, correctLetter: edit.correct == null ? null : String.fromCharCode(65 + edit.correct),
      subject: edit.subject?.trim() || source.subject || 'General', year: edit.year ?? source.year,
      explanation: edit.explanation ?? source.explanation, incomplete: false, needsReview: false,
      reviewReasons: [], qualityFlags: [], answerSource: 'student_review' };
  });
}
