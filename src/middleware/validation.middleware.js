const Joi = require("joi");
const { ValidationError } = require("../utils/errors");

const validate = (schema, property = "body") => {
  return (req, res, next) => {
    const { error } = schema.validate(req[property]);

    if (error) {
      const errorMessage = error.details
        .map((detail) => detail.message)
        .join(", ");
      return next(new ValidationError(errorMessage));
    }

    next();
  };
};

// CUID pattern for validation (Prisma's default CUID format)
const CUID_PATTERN = /^c[a-z0-9]{24}$/;

// Common validation schemas
const schemas = {
  // Auth validation
  githubLogin: Joi.object({
    code: Joi.string().required().messages({
      "any.required": "GitHub authorization code is required",
      "string.empty": "GitHub authorization code cannot be empty",
    }),
  }),

  refreshToken: Joi.object({
    token: Joi.string().required().messages({
      "any.required": "Refresh token is required",
      "string.empty": "Refresh token cannot be empty",
    }),
  }),

  // Repository validation
  createRepository: Joi.object({
    fullName: Joi.string()
      .pattern(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/)
      .required()
      .messages({
        "string.pattern.base":
          'Repository name must be in format "owner/repository"',
        "any.required": "Repository full name is required",
      }),
  }),

  // Analysis validation
  createAnalysis: Joi.object({
    prNumber: Joi.number().integer().min(1).max(99999).required().messages({
      "number.base": "PR number must be a number",
      "number.integer": "PR number must be an integer",
      "number.min": "PR number must be at least 1",
      "number.max": "PR number must be less than 100000",
      "any.required": "PR number is required",
    }),
  }),

  // Common params validation
  id: Joi.object({
    id: Joi.string().pattern(CUID_PATTERN).required().messages({
      "string.pattern.base": "ID must be a valid CUID",
      "any.required": "ID is required",
    }),
  }),

  // Repository ID specific validation
  repositoryId: Joi.object({
    id: Joi.string().pattern(CUID_PATTERN).required().messages({
      "string.pattern.base": "Repository ID must be a valid CUID",
      "any.required": "Repository ID is required",
    }),
  }),

  // Analysis ID specific validation
  analysisId: Joi.object({
    id: Joi.string().pattern(CUID_PATTERN).required().messages({
      "string.pattern.base": "Analysis ID must be a valid CUID",
      "any.required": "Analysis ID is required",
    }),
  }),

  // Pagination and filtering validation
  pagination: Joi.object({
    page: Joi.number().integer().min(1).max(1000).default(1).messages({
      "number.base": "Page must be a number",
      "number.integer": "Page must be an integer",
      "number.min": "Page must be at least 1",
      "number.max": "Page cannot exceed 1000",
    }),
    limit: Joi.number().integer().min(1).max(100).default(10).messages({
      "number.base": "Limit must be a number",
      "number.integer": "Limit must be an integer",
      "number.min": "Limit must be at least 1",
      "number.max": "Limit cannot exceed 100",
    }),
  }),

  // Query parameters for user analyses
  getUserAnalysesQuery: Joi.object({
    page: Joi.number().integer().min(1).max(1000).default(1),
    limit: Joi.number().integer().min(1).max(50).default(10),
    status: Joi.string()
      .valid("PENDING", "PROCESSING", "COMPLETED", "FAILED")
      .optional()
      .messages({
        "any.only":
          "Status must be one of: PENDING, PROCESSING, COMPLETED, FAILED",
      }),
    repositoryId: Joi.string().pattern(CUID_PATTERN).optional().messages({
      "string.pattern.base": "Repository ID must be a valid CUID",
    }),
    sortBy: Joi.string()
      .valid("createdAt", "completedAt", "status", "prNumber")
      .default("createdAt")
      .messages({
        "any.only":
          "Sort field must be one of: createdAt, completedAt, status, prNumber",
      }),
    sortOrder: Joi.string().valid("asc", "desc").default("desc").messages({
      "any.only": "Sort order must be either asc or desc",
    }),
  }).unknown(false), // Don't allow unknown query parameters
};

// Custom validation functions
const customValidators = {
  /**
   * Validate if string is a valid CUID
   */
  isCuid: (value) => {
    return CUID_PATTERN.test(value);
  },

  /**
   * Validate GitHub repository name format
   */
  isGitHubRepoName: (value) => {
    return /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(value);
  },

  /**
   * Validate PR number range
   */
  isValidPRNumber: (value) => {
    const num = parseInt(value);
    return Number.isInteger(num) && num >= 1 && num <= 99999;
  },
};

// Middleware to validate multiple properties
const validateMultiple = (validations) => {
  return (req, res, next) => {
    const errors = [];

    for (const { schema, property = "body", name } of validations) {
      const { error } = schema.validate(req[property]);
      if (error) {
        const propertyName = name || property;
        errors.push(
          `${propertyName}: ${error.details.map((d) => d.message).join(", ")}`
        );
      }
    }

    if (errors.length > 0) {
      return next(new ValidationError(errors.join("; ")));
    }

    next();
  };
};

// Middleware to sanitize input
const sanitize = (property = "body") => {
  return (req, res, next) => {
    if (req[property] && typeof req[property] === "object") {
      // Remove any null prototype objects and clean strings
      req[property] = JSON.parse(JSON.stringify(req[property]));

      // Trim string values
      const trimStrings = (obj) => {
        Object.keys(obj).forEach((key) => {
          if (typeof obj[key] === "string") {
            obj[key] = obj[key].trim();
          } else if (typeof obj[key] === "object" && obj[key] !== null) {
            trimStrings(obj[key]);
          }
        });
      };

      trimStrings(req[property]);
    }
    next();
  };
};

// Export everything
module.exports = {
  validate,
  validateMultiple,
  sanitize,
  schemas,
  customValidators,
  CUID_PATTERN,
};
