const express = require('express');
const authController = require('../controllers/auth.controller');
const authMiddleware = require('../middleware/auth.middleware');
const { validate, schemas } = require('../middleware/validation.middleware');

const router = express.Router();

// Public routes
router.post('/github', 
  validate(schemas.githubLogin), 
  authController.githubLogin
);

router.post('/refresh', 
  validate(schemas.refreshToken), 
  authController.refreshToken
);

// Protected routes
router.get('/me', 
  authMiddleware, 
  authController.getCurrentUser
);

router.post('/logout', 
  authMiddleware, 
  authController.logout
);

module.exports = router;