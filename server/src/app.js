require('dotenv').config({ quiet: true });
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

const { correlationId, attachUser } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const agencyRoutes = require('./routes/agencies');
const userRoutes = require('./routes/users');
const leadRoutes = require('./routes/leads');
const taskRoutes = require('./routes/tasks');
const workQueueRoutes = require('./routes/workqueue');
const startMyDayRoutes = require('./routes/startmyday');
const telemarketerRoutes = require('./routes/telemarketers');
const transferRoutes = require('./routes/transfers');
const vendorRoutes = require('./routes/vendors');
const vendorApiRoutes = require('./routes/vendorApi');
const financialRoutes = require('./routes/financials');
const edRoutes = require('./routes/ed');
const supportRoutes = require('./routes/support');
const callRoutes = require('./routes/calls');
const billingRoutes = require('./routes/billing');
const trainingRoutes = require('./routes/training');
const notificationRoutes = require('./routes/notifications');
const opportunityRoutes = require('./routes/opportunities');
const customerRoutes = require('./routes/customers');
const goalRoutes = require('./routes/goals');
const impersonationRoutes = require('./routes/impersonation');
const flowScoreRoutes = require('./routes/flowScore');
const chatRoutes = require('./routes/chat');
const healthRoutes = require('./routes/health');

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(
  cors({
    origin: process.env.APP_URL || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(correlationId);
app.use(attachUser);

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/agencies', agencyRoutes);
app.use('/api/users', userRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/work-queue', workQueueRoutes);
app.use('/api/start-my-day', startMyDayRoutes);
app.use('/api/telemarketers', telemarketerRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/financials', financialRoutes);
app.use('/api/ed', edRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/training', trainingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/opportunities', opportunityRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/goals', goalRoutes);
app.use('/api/impersonation', impersonationRoutes);
app.use('/api/flow-score', flowScoreRoutes);
app.use('/api/chat', chatRoutes);
// Public, vendor-authenticated Direct POST API — versioned per spec.
app.use('/api/v1', vendorApiRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'NOT_FOUND', correlationId: req.correlationId });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] correlationId=${req.correlationId}`, err);
  res.status(err.status || 500).json({
    success: false,
    error: 'INTERNAL_ERROR',
    message: 'Something went wrong on our end.',
    correlationId: req.correlationId,
  });
});

module.exports = app;
