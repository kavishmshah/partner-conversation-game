/**
 * Dice faces 1–6 map to categories in fixed order.
 */
import { life } from './data/life.js';
import { career } from './data/career.js';
import { hobbies } from './data/hobbies.js';
import { emotions } from './data/emotions.js';
import { family } from './data/family.js';
import { future } from './data/future.js';

export const CATEGORIES = [life, career, hobbies, emotions, family, future];

export const CATEGORY_BY_DICE = {
  1: life,
  2: career,
  3: hobbies,
  4: emotions,
  5: family,
  6: future,
};

export function categoryFromDice(n) {
  const v = ((Number(n) - 1) % 6) + 1;
  return CATEGORY_BY_DICE[v];
}

export function findQuestion(categoryId, questionId) {
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) return null;
  return cat.questions.find((q) => q.id === questionId) || null;
}
