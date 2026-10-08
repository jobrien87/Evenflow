// Backstage HR — composes every Phase 1 Part A sub-router under one
// mount point. requireAuth + the hrEnabled module gate are applied once
// here, mirroring calls.js's router.use(requireAuth);
// router.use(requireSalesStudioAccess) pattern for its whole router.
const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { requireModuleEnabled } = require('../../lib/entitlements');

const router = express.Router();

router.use(requireAuth);
router.use(requireModuleEnabled('hrEnabled'));

router.use('/departments', require('./departments'));
router.use('/positions', require('./positions'));
router.use('/legal-employers', require('./legalEmployers'));
router.use('/role-grants', require('./roleGrants'));
router.use('/employees', require('./employees'));
router.use('/overview', require('./overview'));
router.use('/', require('./timeAttendance'));

module.exports = router;
