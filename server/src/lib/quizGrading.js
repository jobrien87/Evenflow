// Server-side quiz grading. The client only ever submits selected answer
// indexes, never a score, so there is no way to fake a passing score by
// tampering with the request — the server is the sole source of truth for
// what's correct.

function gradeQuiz(quiz, answers) {
  if (!Array.isArray(quiz) || quiz.length === 0) {
    return { scorePercent: null, correctCount: 0, total: 0, reason: 'This lesson has no quiz.' };
  }
  if (!Array.isArray(answers) || answers.length !== quiz.length) {
    return { scorePercent: 0, correctCount: 0, total: quiz.length, reason: 'Incomplete or malformed answers submitted.' };
  }

  let correctCount = 0;
  const results = quiz.map((q, i) => {
    const isCorrect = answers[i] === q.correctIndex;
    if (isCorrect) correctCount++;
    return { question: q.question, correct: isCorrect, correctIndex: q.correctIndex, submittedIndex: answers[i] };
  });

  const scorePercent = Math.round((correctCount / quiz.length) * 100);
  return { scorePercent, correctCount, total: quiz.length, results };
}

module.exports = { gradeQuiz };
