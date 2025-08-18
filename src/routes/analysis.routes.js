const express = require('express');
const analysisController = require('../controllers/analysis.controller');
const authMiddleware = require('../middleware/auth.middleware');
const { validate, schemas } = require('../middleware/validation.middleware');

const router = express.Router();

// All analysis routes require authentication
router.use(authMiddleware);

router.post('/repositories/:id/analyze', 
  validate(schemas.id, 'params'),
  validate(schemas.createAnalysis), 
  analysisController.createAnalysis
);

router.get('/:id', 
  validate(schemas.id, 'params'), 
  analysisController.getAnalysis
);

router.get('/', analysisController.getUserAnalyses);

module.exports = router;