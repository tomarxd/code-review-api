const express = require('express');
const repositoryController = require('../controllers/repository.controller');
const authMiddleware = require('../middleware/auth.middleware');
const { validate, schemas } = require('../middleware/validation.middleware');

const router = express.Router();

// All repository routes require authentication
router.use(authMiddleware);

router.get('/', repositoryController.getRepositories);

router.post('/', 
  validate(schemas.createRepository), 
  repositoryController.createRepository
);

router.get('/:id', 
  validate(schemas.id, 'params'), 
  repositoryController.getRepository
);

router.delete('/:id', 
  validate(schemas.id, 'params'), 
  repositoryController.deleteRepository
);

// Get pull requests for a repository
router.get('/:id/pulls', 
  validate(schemas.id, 'params'), 
  repositoryController.getRepositoryPullRequests
);

module.exports = router;