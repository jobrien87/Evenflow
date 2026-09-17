const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { requireModuleEnabled } = require('../lib/entitlements');
const { gradeQuiz } = require('../lib/quizGrading');
const { recommendTrainingForProducer } = require('../lib/trainingRecommendation');
const { notifyUser } = require('../lib/notifications');

const router = express.Router();
router.use(requireAuth);
router.use(requireModuleEnabled('coachingEnabled'));

router.get('/courses', async (req, res, next) => {
  try {
    const courses = await prisma.trainingCourse.findMany({
      where: { isActive: true },
      include: { lessons: { orderBy: { orderIndex: 'asc' }, select: { id: true, title: true, orderIndex: true, quiz: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, courses });
  } catch (err) {
    next(err);
  }
});

router.get('/courses/:id', async (req, res, next) => {
  try {
    const course = await prisma.trainingCourse.findUnique({
      where: { id: req.params.id },
      include: { lessons: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!course) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    return res.json({ success: true, course });
  } catch (err) {
    next(err);
  }
});

const createCourseSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
});

router.post('/courses', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createCourseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const course = await prisma.trainingCourse.create({ data: { ...parsed.data, createdById: req.user.id } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role,
      action: 'training.course_created', entityType: 'TrainingCourse', entityId: course.id,
      after: parsed.data, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, course });
  } catch (err) {
    next(err);
  }
});

router.patch('/courses/:id', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createCourseSchema.partial().extend({ isActive: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION' });
    const course = await prisma.trainingCourse.update({ where: { id: req.params.id }, data: parsed.data });
    return res.json({ success: true, course });
  } catch (err) {
    next(err);
  }
});

const quizQuestionSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2),
  correctIndex: z.number().int().min(0),
});

const createLessonSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  videoUrl: z.string().url().optional().or(z.literal('')),
  orderIndex: z.number().int().default(0),
  quiz: z.array(quizQuestionSchema).optional(),
});

router.post('/courses/:id/lessons', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createLessonSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const course = await prisma.trainingCourse.findUnique({ where: { id: req.params.id } });
    if (!course) return res.status(404).json({ success: false, error: 'COURSE_NOT_FOUND' });

    if (parsed.data.quiz) {
      for (const q of parsed.data.quiz) {
        if (q.correctIndex >= q.options.length) {
          return res.status(400).json({ success: false, error: 'VALIDATION', message: `correctIndex out of range for question "${q.question}"` });
        }
      }
    }

    const lesson = await prisma.trainingLesson.create({
      data: { ...parsed.data, videoUrl: parsed.data.videoUrl || null, courseId: course.id, quiz: parsed.data.quiz || null },
    });
    return res.status(201).json({ success: true, lesson });
  } catch (err) {
    next(err);
  }
});

const assignSchema = z.object({
  courseId: z.string().uuid(),
  userId: z.string().uuid(),
  dueAt: z.string().datetime().optional(),
});

router.post('/assign', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const targetUser = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
    if (!targetUser) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && targetUser.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const existing = await prisma.trainingAssignment.findUnique({
      where: { courseId_userId: { courseId: parsed.data.courseId, userId: parsed.data.userId } },
    });
    if (existing) {
      return res.status(409).json({ success: false, error: 'ALREADY_ASSIGNED' });
    }

    const assignment = await prisma.trainingAssignment.create({
      data: {
        courseId: parsed.data.courseId,
        userId: parsed.data.userId,
        assignedById: req.user.id,
        dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
      },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: targetUser.agencyId,
      action: 'training.assigned', entityType: 'TrainingAssignment', entityId: assignment.id,
      after: { courseId: parsed.data.courseId, userId: parsed.data.userId }, correlationId: req.correlationId,
    });

    const course = await prisma.trainingCourse.findUnique({ where: { id: parsed.data.courseId }, select: { title: true } });
    await notifyUser({
      userId: parsed.data.userId,
      agencyId: targetUser.agencyId,
      type: 'training.assigned',
      severity: 'INFO',
      title: 'New training assigned',
      body: course ? course.title : undefined,
      relatedEntityType: 'TrainingAssignment',
      relatedEntityId: assignment.id,
    });

    return res.status(201).json({ success: true, assignment });
  } catch (err) {
    next(err);
  }
});

router.get('/my-assignments', async (req, res, next) => {
  try {
    const assignments = await prisma.trainingAssignment.findMany({
      where: { userId: req.user.id },
      include: {
        course: { include: { lessons: { orderBy: { orderIndex: 'asc' } } } },
        lessonCompletions: true,
      },
      orderBy: { assignedAt: 'desc' },
    });
    const withProgress = assignments.map((a) => ({
      ...a,
      progress: { completed: a.lessonCompletions.length, total: a.course.lessons.length },
    }));
    return res.json({ success: true, assignments: withProgress });
  } catch (err) {
    next(err);
  }
});

router.get('/assignments', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const where = req.user.role === 'PLATFORM_OWNER'
      ? {}
      : { user: { agencyId: req.user.agencyId } };
    const assignments = await prisma.trainingAssignment.findMany({
      where,
      include: {
        course: { include: { lessons: { select: { id: true } } } },
        user: { select: { firstName: true, lastName: true } },
        lessonCompletions: true,
      },
      orderBy: { assignedAt: 'desc' },
    });
    const withProgress = assignments.map((a) => ({
      ...a,
      progress: { completed: a.lessonCompletions.length, total: a.course.lessons.length },
    }));
    return res.json({ success: true, assignments: withProgress });
  } catch (err) {
    next(err);
  }
});

const completeLessonSchema = z.object({
  assignmentId: z.string().uuid(),
  answers: z.array(z.number().int()).optional(),
});

router.post('/lessons/:lessonId/complete', async (req, res, next) => {
  try {
    const parsed = completeLessonSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const [lesson, assignment] = await Promise.all([
      prisma.trainingLesson.findUnique({ where: { id: req.params.lessonId } }),
      prisma.trainingAssignment.findUnique({ where: { id: parsed.data.assignmentId }, include: { course: { include: { lessons: true } } } }),
    ]);
    if (!lesson || !assignment) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (assignment.userId !== req.user.id) return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    if (assignment.courseId !== lesson.courseId) return res.status(400).json({ success: false, error: 'LESSON_NOT_IN_COURSE' });

    const grading = lesson.quiz ? gradeQuiz(lesson.quiz, parsed.data.answers) : { scorePercent: null };

    const completion = await prisma.lessonCompletion.upsert({
      where: { assignmentId_lessonId: { assignmentId: assignment.id, lessonId: lesson.id } },
      update: { quizScorePercent: grading.scorePercent, quizAnswers: parsed.data.answers || null },
      create: {
        assignmentId: assignment.id,
        lessonId: lesson.id,
        quizScorePercent: grading.scorePercent,
        quizAnswers: parsed.data.answers || null,
      },
    });

    const totalLessons = assignment.course.lessons.length;
    const completedCount = await prisma.lessonCompletion.count({ where: { assignmentId: assignment.id } });
    const newStatus = completedCount >= totalLessons ? 'COMPLETED' : 'IN_PROGRESS';

    await prisma.trainingAssignment.update({
      where: { id: assignment.id },
      data: { status: newStatus, completedAt: newStatus === 'COMPLETED' ? new Date() : null },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role,
      action: 'training.lesson_completed', entityType: 'LessonCompletion', entityId: completion.id,
      after: { quizScorePercent: grading.scorePercent }, correlationId: req.correlationId,
    });

    return res.json({ success: true, completion, grading, assignmentStatus: newStatus });
  } catch (err) {
    next(err);
  }
});

router.get('/recommended', requireRole('PRODUCER'), async (req, res, next) => {
  try {
    const result = await recommendTrainingForProducer(req.user.id);
    return res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
