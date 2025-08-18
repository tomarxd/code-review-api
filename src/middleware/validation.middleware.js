const Joi = require('joi');
const { ValidationError } = require('../utils/errors');

const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    const { error } = schema.validate(req[property]);
    
    if (error) {
      const errorMessage = error.details.map(detail => detail.message).join(', ');
      return next(new ValidationError(errorMessage));
    }
    
    next();
  };
};

// Common validation schemas
const schemas = {
  // Auth validation
  githubLogin: Joi.object({
    code: Joi.string().required()
  }),

  refreshToken: Joi.object({
    token: Joi.string().required()
  }),

  // Repository validation
  createRepository: Joi.object({
    fullName: Joi.string().pattern(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/).required()
  }),

  // Analysis validation
  createAnalysis: Joi.object({
    prNumber: Joi.number().integer().min(1).required()
  }),

  // Common params validation - using a more flexible pattern for CUID
  id: Joi.object({
    id: Joi.string().min(20).max(30).pattern(/^[a-z0-9]+$/).required()
  })
};

module.exports = {
  validate,
  schemas
};