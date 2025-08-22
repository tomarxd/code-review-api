const prisma = require("../config/database");
const redis = require("../config/redis");
const ApiResponse = require("../utils/response");
const {
  NotFoundError,
  ValidationError,
  AuthorizationError,
} = require("../utils/errors");
const analysisService = require("../services/analysis.service");
const githubService = require("../services/github.service");

class AnalysisController {
  /**
   * Create a new analysis for a pull request
   * POST /api/analyses/repositories/:id/analyze
   */
  async createAnalysis(req, res, next) {
    try {
      const { id: repositoryId } = req.params;
      const { prNumber } = req.body;
      const userId = req.user.userId;

      // 1. Verify repository ownership
      const repository = await prisma.repository.findFirst({
        where: {
          id: repositoryId,
          userId: userId,
          isActive: true,
        },
      });

      if (!repository) {
        throw new NotFoundError("Repository not found or access denied");
      }

      // 2. Verify repository access with GitHub
      const hasAccess = await githubService.verifyRepoAccess(
        repository.fullName,
        req.user.githubId
      );

      if (!hasAccess) {
        throw new AuthorizationError("No access to this repository on GitHub");
      }

      // 3. Check if analysis already exists for this PR
      const existingAnalysis = await prisma.analysis.findUnique({
        where: {
          repositoryId_prNumber: {
            repositoryId: repositoryId,
            prNumber: prNumber,
          },
        },
      });

      if (existingAnalysis) {
        // If analysis is already completed, return it
        if (existingAnalysis.status === "COMPLETED") {
          const analysisWithSuggestions =
            await analysisService.getAnalysisWithSuggestions(
              existingAnalysis.id
            );

          return ApiResponse.success(
            res,
            {
              analysisId: existingAnalysis.id,
              status: existingAnalysis.status,
              analysis: analysisWithSuggestions,
            },
            "Analysis already exists"
          );
        }

        // If analysis is in progress, return current status
        if (
          existingAnalysis.status === "PROCESSING" ||
          existingAnalysis.status === "PENDING"
        ) {
          return ApiResponse.accepted(
            res,
            {
              analysisId: existingAnalysis.id,
              status: existingAnalysis.status,
              createdAt: existingAnalysis.createdAt,
            },
            "Analysis is already in progress"
          );
        }

        // If previous analysis failed, we can create a new one
        if (existingAnalysis.status === "FAILED") {
          await prisma.analysis.delete({
            where: { id: existingAnalysis.id },
          });
        }
      }

      // 4. Verify PR exists on GitHub
      try {
        const prInfo = await githubService.getPRInfo(
          repository.fullName,
          prNumber
        );
        if (!prInfo) {
          throw new ValidationError(
            `Pull request #${prNumber} not found in ${repository.fullName}`
          );
        }
      } catch (error) {
        throw new ValidationError(
          `Unable to access pull request #${prNumber}: ${error.message}`
        );
      }

      // 5. Create analysis record
      const analysisData = {
        repositoryId: repositoryId,
        userId: userId,
        prNumber: prNumber,
        commitSha: "", // Will be updated during processing
        status: "PENDING",
        totalLines: null,
      };

      const analysis = await analysisService.createAnalysis(analysisData);

      // 6. Start background processing (non-blocking)
      setImmediate(async () => {
        try {
          await analysisService.processAnalysis(
            analysis.id,
            repositoryId,
            prNumber,
            repository.fullName
          );
        } catch (error) {
          console.error(
            `Analysis processing failed for ${analysis.id}:`,
            error
          );

          // Update analysis status to failed
          await analysisService.updateAnalysisStatus(analysis.id, "FAILED");

          // Optionally, you can emit a WebSocket event here for real-time updates
          // this.emitAnalysisUpdate(analysis.id, 'FAILED', error.message);
        }
      });

      // 7. Invalidate user analyses cache
      await redis.del(`user:analyses:${userId}`);

      // 8. Return analysis ID immediately
      ApiResponse.accepted(
        res,
        {
          analysisId: analysis.id,
          status: "PENDING",
          repositoryName: repository.name,
          prNumber: prNumber,
          createdAt: analysis.createdAt,
          estimatedTime: "2-5 minutes",
        },
        "Analysis started successfully"
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get analysis results with suggestions
   * GET /api/analyses/:id
   */
  async getAnalysis(req, res, next) {
    try {
      const { id: analysisId } = req.params;
      const userId = req.user.userId;

      // 1. Check Redis cache first for completed analyses
      const cacheKey = `analysis:${analysisId}`;
      const cached = await redis.get(cacheKey);

      if (cached) {
        const cachedData = JSON.parse(cached);

        // Verify user has access to this analysis
        if (cachedData.userId !== userId) {
          throw new AuthorizationError("Access denied to this analysis");
        }

        return ApiResponse.success(
          res,
          cachedData,
          "Analysis retrieved from cache"
        );
      }

      // 2. Query analysis with suggestions from database
      const analysis = await analysisService.getAnalysisWithSuggestions(
        analysisId
      );

      if (!analysis) {
        throw new NotFoundError("Analysis not found");
      }

      // 3. Verify user ownership
      if (analysis.userId !== userId) {
        throw new AuthorizationError("Access denied to this analysis");
      }

      // 4. Format response data
      const responseData = {
        id: analysis.id,
        repositoryId: analysis.repositoryId,
        repository: {
          id: analysis.repository.id,
          name: analysis.repository.name,
          fullName: analysis.repository.fullName,
        },
        prNumber: analysis.prNumber,
        commitSha: analysis.commitSha,
        status: analysis.status,
        totalLines: analysis.totalLines,
        createdAt: analysis.createdAt,
        completedAt: analysis.completedAt,
        suggestions: analysis.suggestions.map((suggestion) => ({
          id: suggestion.id,
          filePath: suggestion.filePath,
          lineNumber: suggestion.lineNumber,
          severity: suggestion.severity,
          category: suggestion.category,
          message: suggestion.message,
          suggestion: suggestion.suggestion,
          codeSnippet: suggestion.codeSnippet,
        })),
        summary: {
          totalSuggestions: analysis.suggestions.length,
          highSeverity: analysis.suggestions.filter(
            (s) => s.severity === "HIGH"
          ).length,
          mediumSeverity: analysis.suggestions.filter(
            (s) => s.severity === "MEDIUM"
          ).length,
          lowSeverity: analysis.suggestions.filter((s) => s.severity === "LOW")
            .length,
          categories: this.groupSuggestionsByCategory(analysis.suggestions),
        },
      };

      // 5. Cache completed results for 1 hour
      if (analysis.status === "COMPLETED") {
        await redis.setex(
          cacheKey,
          3600,
          JSON.stringify({
            ...responseData,
            userId: analysis.userId, // Include userId in cache for access control
          })
        );
      }

      ApiResponse.success(res, responseData, "Analysis retrieved successfully");
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get user's analyses with pagination
   * GET /api/analyses
   */
  async getUserAnalyses(req, res, next) {
    try {
      const userId = req.user.userId;
      const {
        page = 1,
        limit = 10,
        status,
        repositoryId,
        sortBy = "createdAt",
        sortOrder = "desc",
      } = req.query;

      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.max(1, Math.min(50, parseInt(limit))); // Max 50 per page
      const offset = (pageNum - 1) * limitNum;

      // Build cache key
      const cacheKey = `user:analyses:${userId}:${pageNum}:${limitNum}:${
        status || "all"
      }:${repositoryId || "all"}:${sortBy}:${sortOrder}`;

      // 1. Check cache first
      const cached = await redis.get(cacheKey);
      if (cached) {
        const cachedData = JSON.parse(cached);
        return ApiResponse.success(
          res,
          cachedData,
          "Analyses retrieved from cache"
        );
      }

      // 2. Build where clause
      const whereClause = {
        userId: userId,
      };

      if (status) {
        whereClause.status = status.toUpperCase();
      }

      if (repositoryId) {
        whereClause.repositoryId = repositoryId;
      }

      // 3. Build order clause
      const validSortFields = [
        "createdAt",
        "completedAt",
        "status",
        "prNumber",
      ];
      const sortField = validSortFields.includes(sortBy) ? sortBy : "createdAt";
      const order = sortOrder.toLowerCase() === "asc" ? "asc" : "desc";

      // 4. Query analyses with pagination
      const [analyses, totalCount] = await Promise.all([
        prisma.analysis.findMany({
          where: whereClause,
          include: {
            repository: {
              select: {
                id: true,
                name: true,
                fullName: true,
              },
            },
            suggestions: {
              select: {
                severity: true,
              },
            },
          },
          orderBy: {
            [sortField]: order,
          },
          skip: offset,
          take: limitNum,
        }),
        prisma.analysis.count({
          where: whereClause,
        }),
      ]);

      // 5. Format response data
      const formattedAnalyses = analyses.map((analysis) => ({
        id: analysis.id,
        repository: analysis.repository,
        prNumber: analysis.prNumber,
        commitSha: analysis.commitSha,
        status: analysis.status,
        totalLines: analysis.totalLines,
        createdAt: analysis.createdAt,
        completedAt: analysis.completedAt,
        suggestionsCount: analysis.suggestions.length,
        severityBreakdown: {
          high: analysis.suggestions.filter((s) => s.severity === "HIGH")
            .length,
          medium: analysis.suggestions.filter((s) => s.severity === "MEDIUM")
            .length,
          low: analysis.suggestions.filter((s) => s.severity === "LOW").length,
        },
      }));

      const responseData = {
        analyses: formattedAnalyses,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
          hasNext: pageNum < Math.ceil(totalCount / limitNum),
          hasPrev: pageNum > 1,
        },
        filters: {
          status,
          repositoryId,
        },
        sort: {
          field: sortField,
          order,
        },
      };

      // 6. Cache results for 5 minutes
      await redis.setex(cacheKey, 300, JSON.stringify(responseData));

      ApiResponse.success(res, responseData, "Analyses retrieved successfully");
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete an analysis
   * DELETE /api/analyses/:id
   */
  async deleteAnalysis(req, res, next) {
    try {
      const { id: analysisId } = req.params;
      const userId = req.user.userId;

      // 1. Verify analysis exists and user owns it
      const analysis = await prisma.analysis.findUnique({
        where: { id: analysisId },
        select: { id: true, userId: true, status: true },
      });

      if (!analysis) {
        throw new NotFoundError("Analysis not found");
      }

      if (analysis.userId !== userId) {
        throw new AuthorizationError("Access denied to this analysis");
      }

      // 2. Prevent deletion of processing analyses
      if (analysis.status === "PROCESSING") {
        throw new ValidationError(
          "Cannot delete analysis that is currently processing"
        );
      }

      // 3. Delete analysis (cascades to suggestions)
      await prisma.analysis.delete({
        where: { id: analysisId },
      });

      // 4. Clear related caches
      await Promise.all([
        redis.del(`analysis:${analysisId}`),
        redis.del(`user:analyses:${userId}`),
      ]);

      ApiResponse.success(res, null, "Analysis deleted successfully");
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get analysis statistics for user
   * GET /api/analyses/stats
   */
  async getAnalysisStats(req, res, next) {
    try {
      const userId = req.user.userId;
      const cacheKey = `user:stats:${userId}`;

      // 1. Check cache first
      const cached = await redis.get(cacheKey);
      if (cached) {
        return ApiResponse.success(
          res,
          JSON.parse(cached),
          "Stats retrieved from cache"
        );
      }

      // 2. Get statistics from database
      const [
        totalAnalyses,
        completedAnalyses,
        failedAnalyses,
        processingAnalyses,
        totalSuggestions,
        recentAnalyses,
      ] = await Promise.all([
        prisma.analysis.count({ where: { userId } }),
        prisma.analysis.count({ where: { userId, status: "COMPLETED" } }),
        prisma.analysis.count({ where: { userId, status: "FAILED" } }),
        prisma.analysis.count({
          where: { userId, status: { in: ["PENDING", "PROCESSING"] } },
        }),
        prisma.suggestion.count({
          where: {
            analysis: { userId },
          },
        }),
        prisma.analysis.findMany({
          where: { userId },
          include: {
            repository: { select: { name: true, fullName: true } },
            suggestions: { select: { severity: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 5,
        }),
      ]);

      // 3. Calculate additional stats
      const avgSuggestionsPerAnalysis =
        completedAnalyses > 0
          ? Math.round(totalSuggestions / completedAnalyses)
          : 0;

      const recentAnalysesFormatted = recentAnalyses.map((analysis) => ({
        id: analysis.id,
        repositoryName: analysis.repository.name,
        prNumber: analysis.prNumber,
        status: analysis.status,
        createdAt: analysis.createdAt,
        suggestionsCount: analysis.suggestions.length,
        highSeverityCount: analysis.suggestions.filter(
          (s) => s.severity === "HIGH"
        ).length,
      }));

      const stats = {
        overview: {
          totalAnalyses,
          completedAnalyses,
          failedAnalyses,
          processingAnalyses,
          successRate:
            totalAnalyses > 0
              ? Math.round((completedAnalyses / totalAnalyses) * 100)
              : 0,
        },
        suggestions: {
          totalSuggestions,
          avgSuggestionsPerAnalysis,
        },
        recentActivity: recentAnalysesFormatted,
      };

      // 4. Cache for 10 minutes
      await redis.setex(cacheKey, 600, JSON.stringify(stats));

      ApiResponse.success(res, stats, "Statistics retrieved successfully");
    } catch (error) {
      next(error);
    }
  }

  /**
   * Helper method to group suggestions by category
   */
  groupSuggestionsByCategory(suggestions) {
    const categories = {};

    suggestions.forEach((suggestion) => {
      if (!categories[suggestion.category]) {
        categories[suggestion.category] = {
          count: 0,
          severityBreakdown: { HIGH: 0, MEDIUM: 0, LOW: 0 },
        };
      }

      categories[suggestion.category].count++;
      categories[suggestion.category].severityBreakdown[suggestion.severity]++;
    });

    return categories;
  }

  /**
   * Helper method to emit analysis updates (for WebSocket integration)
   * This can be used when you add Socket.IO
   */
  emitAnalysisUpdate(analysisId, status, message = null) {
    // Implementation would depend on your WebSocket setup
    // Example with Socket.IO:
    // this.io.to(`analysis:${analysisId}`).emit('analysisUpdate', {
    //   analysisId,
    //   status,
    //   message,
    //   timestamp: new Date().toISOString()
    // });
  }
}

module.exports = new AnalysisController();
