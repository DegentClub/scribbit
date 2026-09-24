import { describe, expect, it } from 'vitest';
import { explainStep, GLOSSARY, GOAL_SECONDS, playgroundDocument, QUIZ, scoreQuiz, STEP_IDS, stepContent, STEPS, UnknownStepError } from '../src/index.js';

describe('steps', () => {
  it('five steps, numbered 1..5, in STEP_IDS order', () => {
    expect(STEPS.map((s) => s.id)).toEqual([...STEP_IDS]);
    expect(STEPS.map((s) => s.number)).toEqual([1, 2, 3, 4, 5]);
    for (const s of STEPS) {
      expect(s.explanation.length).toBeGreaterThanOrEqual(2);
      expect(s.explanation.length).toBeLessThanOrEqual(4);
      expect(s.onChain.length).toBeGreaterThan(10);
    }
  });

  it('every glossary reference resolves and ids are unique anchors', () => {
    const ids = GLOSSARY.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
    for (const s of STEPS) for (const g of s.glossary) expect(ids, `${s.id} → ${g}`).toContain(g);
  });

  it('explainStep accepts numbers, ids and numeric strings; refuses anything else', () => {
    expect(explainStep(2).id).toBe('coins');
    expect(explainStep('inscribe').step).toBe(4);
    expect(explainStep('5').id).toBe('certificate');
    const e = explainStep('wallet');
    expect(e.glossary.map((g) => g.id)).toEqual(stepContent('wallet').glossary);
    expect(e.safety).toMatch(/TEST NETWORK/);
    expect(e.goalSeconds).toBe(GOAL_SECONDS);
    expect(() => explainStep(6)).toThrow(UnknownStepError);
    expect(() => explainStep('mainnet')).toThrow(UnknownStepError);
  });

  it('states protocol facts correctly and never talks price', () => {
    const all = JSON.stringify(playgroundDocument());
    expect(all).toContain('4,000,000 WU');
    expect(all).toContain('400,000 WU');
    expect(all).toContain('330 sats');
    expect(all).toContain('520 bytes');
    expect(all).not.toMatch(/\$|USD|price|invest|profit/i);
  });
});

describe('quiz', () => {
  it('three questions with a valid answer index each', () => {
    expect(QUIZ).toHaveLength(3);
    for (const q of QUIZ) {
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThan(q.options.length);
    }
  });

  it('passes only when all are right', () => {
    const right = QUIZ.map((q) => q.answer);
    expect(scoreQuiz(right)).toEqual({ score: 3, total: 3, passed: true, correct: [true, true, true] });
    const oneWrong = [...right];
    oneWrong[1] = (oneWrong[1]! + 1) % QUIZ[1]!.options.length;
    expect(scoreQuiz(oneWrong)).toMatchObject({ score: 2, passed: false });
    expect(scoreQuiz([])).toMatchObject({ score: 0, passed: false });
  });
});
