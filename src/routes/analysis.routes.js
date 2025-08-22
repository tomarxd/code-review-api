const express = require("express");
const rateLimit = require("express-rate-limit");
const analysisController = require("../controllers/analysis.controller");
const authMiddleware = require("../middleware/auth.middleware");
const { validate, schemas } = require("../middleware/validation.middleware");
const { ValidationError } = require("../utils/errors");
const Joi = require("joi");

const router = express.Router();

// All analysis routes require authentication
router.use(authMiddleware);

// Rate limiting for analysis creation (more restrictive)
const analysisCreationLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each user to 5 analysis requests per 15 minutes
  message: {
    success: false,
    error: {
      message:
        "Too many analysis requests. Please wait before creating another analysis.",
      type: "RATE_LIMIT_EXCEEDED",
      retryAfter: "15 minutes",
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit per user, not per IP
    return req.user?.userId || req.ip;
  },
  skip: (req) => {
    // Skip rate limiting for GET requests (only limit POST requests)
    return req.method !== "POST";
  },
});

// Rate limiting for general analysis endpoints (less restrictive)
const generalAnalysisLimit = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 100, // 100 requests per 10 minutes for general endpoints
  message: {
    success: false,
    error: {
      message: "Too many requests to analysis endpoints. Please slow down.",
      type: "RATE_LIMIT_EXCEEDED",
    },
  },
  keyGenerator: (req) => req.user?.userId || req.ip,
});

// Apply general rate limiting to all routes
router.use(generalAnalysisLimit);

// Extended validation schemas specific to analysis routes
const analysisSchemas = {
  ...schemas,

  // Create analysis validation
  createAnalysis: Joi.object({
    prNumber: Joi.number().integer().min(1).max(99999).required().messages({
      "number.base": "PR number must be a number",
      "number.integer": "PR number must be an integer",
      "number.min": "PR number must be at least 1",
      "number.max": "PR number must be less than 100000",
      "any.required": "PR number is required",
    }),
  }),

  // Query parameters validation for getUserAnalyses
  getUserAnalysesQuery: Joi.object({
    page: Joi.number().integer().min(1).max(1000).default(1),
    limit: Joi.number().integer().min(1).max(50).default(10),
    status: Joi.string()
      .valid("PENDING", "PROCESSING", "COMPLETED", "FAILED")
      .optional(),
    repositoryId: Joi.string()
      .pattern(/^c[a-z0-9]{24}$/) // CUID v2 regex (adjust if you use v1)
      .optional(),
    sortBy: Joi.string()
      .valid("createdAt", "completedAt", "status", "prNumber")
      .default("createdAt"),
    sortOrder: Joi.string().valid("asc", "desc").default("desc"),
  }).unknown(false), // Don't allow unknown query parameters

  // Repository ID validation for params
  repositoryId: Joi.object({
    id: Joi.string()
      .pattern(/^c[a-z0-9]{24}$/) // CUID v2 regex (adjust if you use v1)
      .required()
      .messages({
        "string.base": "Repository ID must be a string",
        "string.pattern.base": "Repository ID must be a valid CUID",
        "any.required": "Repository ID is required",
      }),
  }),

  // Analysis ID validation for params
  analysisId: Joi.object({
    id: Joi.string()
      .pattern(/^c[a-z0-9]{24}$/) // CUID v2 regex (adjust if you use v1)
      .required()
      .messages({
        "string.base": "Analysis ID must be a string",
        "string.pattern.base": "Analysis ID must be a valid CUID",
        "any.required": "Analysis ID is required",
      }),
  }),
};

// Middleware to validate repository access
const validateRepositoryAccess = async (req, res, next) => {
  try {
    const { id: repositoryId } = req.params;
    const userId = req.user.userId;

    // This could be expanded to check Redis cache first
    const prisma = require("../config/database");
    const repository = await prisma.repository.findFirst({
      where: {
        id: repositoryId,
        userId: userId,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        fullName: true,
      },
    });

    if (!repository) {
      return next(new ValidationError("Repository not found or access denied"));
    }

    // Add repository info to request for use in controller
    req.repository = repository;
    next();
  } catch (error) {
    next(error);
  }
};

// Middleware to log analysis requests for monitoring
const logAnalysisRequest = (action) => {
  return (req, res, next) => {
    const logData = {
      userId: req.user.userId,
      action: action,
      repositoryId: req.params.id,
      prNumber: req.body?.prNumber,
      timestamp: new Date().toISOString(),
      userAgent: req.get("User-Agent"),
      ip: req.ip,
    };

    // Log to console (in production, use proper logging service)
    console.log(`[ANALYSIS_${action.toUpperCase()}]`, JSON.stringify(logData));

    // You could also log to database or external service here
    next();
  };
};

/**
 * @route   POST /api/repositories/:id/analyze
 * @desc    Create a new code analysis for a pull request
 * @access  Private
 * @ratelimit 5 requests per 15 minutes per user
 */
router.post(
  "/repositories/:id/analyze",
  analysisCreationLimit,
  validate(analysisSchemas.repositoryId, "params"),
  validate(analysisSchemas.createAnalysis, "body"),
  validateRepositoryAccess,
  logAnalysisRequest("create"),
  analysisController.createAnalysis
);

/**
 * @route   GET /api/analyses/:id
 * @desc    Get analysis results with suggestions
 * @access  Private
 */
router.get(
  "/:id",
  validate(analysisSchemas.analysisId, "params"),
  logAnalysisRequest("get"),
  analysisController.getAnalysis
);

/**
 * @route   GET /api/analyses
 * @desc    Get user's analyses with pagination and filtering
 * @access  Private
 * @query   page, limit, status, repositoryId, sortBy, sortOrder
 */
router.get(
  "/",
  validate(analysisSchemas.getUserAnalysesQuery, "query"),
  logAnalysisRequest("list"),
  analysisController.getUserAnalyses
);

/**
 * @route   DELETE /api/analyses/:id
 * @desc    Delete an analysis
 * @access  Private
 */
router.delete(
  "/:id",
  validate(analysisSchemas.analysisId, "params"),
  logAnalysisRequest("delete"),
  analysisController.deleteAnalysis
);

/**
 * @route   GET /api/analyses/stats
 * @desc    Get user's analysis statistics
 * @access  Private
 */
router.get(
  "/stats",
  logAnalysisRequest("stats"),
  analysisController.getAnalysisStats
);

// Note: The stats route is defined after the parameterized routes
// to avoid conflicts with route matching

/**
 * @route   POST /api/analyses/:id/rerun
 * @desc    Rerun a failed analysis
 * @access  Private
 */
router.post(
  "/:id/rerun",
  analysisCreationLimit,
  validate(analysisSchemas.analysisId, "params"),
  logAnalysisRequest("rerun"),
  async (req, res, next) => {
    try {
      const { id: analysisId } = req.params;
      const userId = req.user.userId;

      // Get the original analysis
      const prisma = require("../config/database");
      const originalAnalysis = await prisma.analysis.findUnique({
        where: { id: analysisId },
        include: {
          repository: {
            select: {
              id: true,
              name: true,
              fullName: true,
            },
          },
        },
      });

      if (!originalAnalysis) {
        return next(new ValidationError("Analysis not found"));
      }

      if (originalAnalysis.userId !== userId) {
        return next(new ValidationError("Access denied to this analysis"));
      }

      if (originalAnalysis.status !== "FAILED") {
        return next(new ValidationError("Can only rerun failed analyses"));
      }

      // Set up request parameters for createAnalysis controller
      req.params.id = originalAnalysis.repositoryId;
      req.body = { prNumber: originalAnalysis.prNumber };
      req.repository = originalAnalysis.repository;

      // Delete the failed analysis
      await prisma.analysis.delete({
        where: { id: analysisId },
      });

      // Call the create analysis controller
      analysisController.createAnalysis(req, res, next);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/analyses/:id/suggestions
 * @desc    Get only suggestions for an analysis (lightweight endpoint)
 * @access  Private
 */
router.get(
  "/:id/suggestions",
  validate(analysisSchemas.analysisId, "params"),
  async (req, res, next) => {
    try {
      const { id: analysisId } = req.params;
      const userId = req.user.userId;
      const { severity, category, page = 1, limit = 20 } = req.query;

      const prisma = require("../config/database");
      const ApiResponse = require("../utils/response");
      const { NotFoundError, AuthorizationError } = require("../utils/errors");

      // Verify analysis ownership
      const analysis = await prisma.analysis.findUnique({
        where: { id: analysisId },
        select: { userId: true, status: true },
      });

      if (!analysis) {
        throw new NotFoundError("Analysis not found");
      }

      if (analysis.userId !== userId) {
        throw new AuthorizationError("Access denied to this analysis");
      }

      // Build where clause for suggestions
      const whereClause = { analysisId };

      if (severity) {
        whereClause.severity = severity.toUpperCase();
      }

      if (category) {
        whereClause.category = category;
      }

      // Get suggestions with pagination
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.max(1, Math.min(50, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      const [suggestions, totalCount] = await Promise.all([
        prisma.suggestion.findMany({
          where: whereClause,
          orderBy: [
            { severity: "asc" }, // HIGH first
            { lineNumber: "asc" },
          ],
          skip: offset,
          take: limitNum,
        }),
        prisma.suggestion.count({ where: whereClause }),
      ]);

      const responseData = {
        suggestions,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
        },
        filters: { severity, category },
        analysisStatus: analysis.status,
      };

      ApiResponse.success(
        res,
        responseData,
        "Suggestions retrieved successfully"
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/analyses/:id/export
 * @desc    Export analysis results in different formats
 * @access  Private
 * @query   format (json, csv)
 */
router.get(
  "/:id/export",
  validate(analysisSchemas.analysisId, "params"),
  async (req, res, next) => {
    try {
      const { id: analysisId } = req.params;
      const { format = "json" } = req.query;
      const userId = req.user.userId;

      if (!["json", "csv"].includes(format)) {
        throw new ValidationError("Format must be json or csv");
      }

      // Get analysis data (reuse the controller logic)
      req.params.id = analysisId;
      const originalJson = res.json;
      let analysisData = null;

      // Intercept the response to get the data
      res.json = (data) => {
        if (data.success && data.data) {
          analysisData = data.data;
        }
        res.json = originalJson;
      };

      await analysisController.getAnalysis(req, res, (error) => {
        if (error) return next(error);

        if (!analysisData) {
          return next(new Error("Failed to retrieve analysis data"));
        }

        if (format === "csv") {
          // Convert to CSV format
          const csvData = analysisData.suggestions.map((s) => ({
            file_path: s.filePath,
            line_number: s.lineNumber,
            severity: s.severity,
            category: s.category,
            message: s.message,
            suggestion: s.suggestion,
          }));

          const csvHeader = Object.keys(csvData[0] || {}).join(",");
          const csvRows = csvData.map((row) =>
            Object.values(row)
              .map((val) =>
                typeof val === "string" && val.includes(",") ? `"${val}"` : val
              )
              .join(",")
          );
          const csvContent = [csvHeader, ...csvRows].join("\n");

          res.setHeader("Content-Type", "text/csv");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="analysis-${analysisId}.csv"`
          );
          return res.send(csvContent);
        }

        // JSON format (default)
        res.setHeader("Content-Type", "application/json");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="analysis-${analysisId}.json"`
        );
        return res.json({
          success: true,
          data: analysisData,
          exportedAt: new Date().toISOString(),
        });
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
