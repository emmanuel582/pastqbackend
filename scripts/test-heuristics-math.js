import { normalizeSpokenMath } from '../services/vision/mathNormalize.js';
import { heuristicPageType, refinePageType } from '../services/vision/models.js';
import { openRouterKeyFingerprint } from '../services/vision/openrouterProvider.js';
import 'dotenv/config';

const mathCases = [
  ['2 raise 2', '$2^{2}$'],
  ['2 raised to 2', '$2^{2}$'],
  ['x squared', '$x^2$'],
  ['square root of 4x', '$\\sqrt{4x}$'],
  ['fraction 3 over 4', '$\\frac{3}{4}$'],
];

let failed = 0;
for (const [input, expected] of mathCases) {
  const got = normalizeSpokenMath(input);
  const ok = got === expected;
  console.log(ok ? 'OK' : 'FAIL', JSON.stringify(input), '→', JSON.stringify(got), ok ? '' : `(want ${JSON.stringify(expected)})`);
  if (!ok) failed += 1;
}

const expl =
  'Explanations to the Answers\n1. The correct option is A because demand is inelastic.\n2. Therefore the burden falls on consumers.';
const h = heuristicPageType(expl);
if (h?.pageType !== 'explanation') {
  console.log('FAIL explanation heuristic', h);
  failed += 1;
} else {
  console.log('OK explanation heuristic');
}

const refined = refinePageType(
  expl,
  { pageType: 'question_content', confidence: 0.98 },
  {
    questions: [
      { question: 'The correct option is A because demand is inelastic.', options: [] },
      { question: 'Therefore the burden falls on consumers.', options: [] },
      { question: 'Hence option C is preferred in this case overall.', options: [] },
    ],
  }
);
if (refined.pageType !== 'explanation' || !refined.dropQuestions) {
  console.log('FAIL refine override', refined);
  failed += 1;
} else {
  console.log('OK refine override');
}

const mcq =
  '1. Which of these is correct?\nA. one\nB. two\nC. three\nD. four\n2. What is 2+2?\nA. 3\nB. 4';
if (heuristicPageType(mcq) !== null) {
  console.log('FAIL mcq should be null', heuristicPageType(mcq));
  failed += 1;
} else {
  console.log('OK mcq not falsely labeled');
}

console.log('OpenRouter fingerprint:', openRouterKeyFingerprint());
process.exit(failed ? 1 : 0);
