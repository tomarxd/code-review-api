const prisma = require("../config/database");
const redis = require("../config/redis");
const githubService = require("./github.service");
const openaiService = require("./openai.service");
const { NotFoundError, ValidationError } = require("../utils/errors");

class AnalysisService {
  // Create a new analysis record
  async createAnalysis(data) {
    try {
      const analysis = await prisma.analysis.create({
        data: {
          repositoryId: data.repositoryId,
          userId: data.userId,
          prNumber: data.prNumber,
          commitSha: data.commitSha || "unknown",
          status: "PENDING",
          totalLines: data.totalLines || null,
        },
        include: {
          repository: {
            select: {
              fullName: true,
              name: true,
            },
          },
        },
      });

      console.log(`Created analysis ${analysis.id} for PR #${data.prNumber}`);
      return analysis;
    } catch (error) {
      // Handle unique constraint violation (duplicate PR analysis)
      if (error.code === "P2002") {
        throw new ValidationError(
          "Analysis already exists for this pull request"
        );
      }

      console.error("Failed to create analysis:", error);
      throw new Error("Failed to create analysis record");
    }
  }

  // Get analysis with suggestions
  async getAnalysisWithSuggestions(analysisId, userId) {
    try {
      // Check cache first
      const cacheKey = `analysis:full:${analysisId}`;
      const cached = await redis.get(cacheKey);

      if (cached) {
        console.log("Using cached full analysis");
        const analysis = JSON.parse(cached);

        // Verify user ownership
        if (analysis.userId !== userId) {
          throw new NotFoundError("Analysis not found");
        }

        return analysis;
      }

      const analysis = await prisma.analysis.findUnique({
        where: { id: analysisId },
        include: {
          repository: {
            select: {
              id: true,
              name: true,
              fullName: true,
            },
          },
          user: {
            select: {
              id: true,
              username: true,
            },
          },
          suggestions: {
            orderBy: [
              { severity: "desc" }, // HIGH first
              { lineNumber: "asc" }, // Then by line number
            ],
          },
        },
      });

      if (!analysis) {
        throw new NotFoundError("Analysis not found");
      }

      // Verify user ownership
      if (analysis.userId !== userId) {
        throw new NotFoundError("Analysis not found");
      }

      // Transform data for response
      const transformedAnalysis = {
        id: analysis.id,
        repositoryId: analysis.repositoryId,
        userId: analysis.userId,
        prNumber: analysis.prNumber,
        commitSha: analysis.commitSha,
        status: analysis.status,
        totalLines: analysis.totalLines,
        createdAt: analysis.createdAt,
        completedAt: analysis.completedAt,
        repository: analysis.repository,
        user: analysis.user,
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
        summary: this.generateAnalysisSummary(analysis.suggestions),
      };

      // Cache completed analyses for 1 hour
      if (analysis.status === "COMPLETED") {
        await redis.setex(cacheKey, 3600, JSON.stringify(transformedAnalysis));
      }

      return transformedAnalysis;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      console.error("Failed to get analysis:", error);
      throw new Error("Failed to retrieve analysis");
    }
  }

  // Process analysis workflow
  async processAnalysis(analysisId) {
    let analysis;

    try {
      // Get analysis details
      analysis = await prisma.analysis.findUnique({
        where: { id: analysisId },
        include: {
          repository: true,
          user: true,
        },
      });

      if (!analysis) {
        throw new Error("Analysis not found");
      }

      console.log(
        `Processing analysis ${analysisId} for PR #${analysis.prNumber}`
      );

      // Update status to PROCESSING
      await this.updateAnalysisStatus(analysisId, "PROCESSING");

      // Step 1: Get PR diff from GitHub
      console.log("Fetching PR diff from GitHub...");
      const prData = await githubService.getPRDiff(
        analysis.repository.fullName,
        analysis.prNumber,
        analysis.userId
      );

      // Step 2: Calculate total lines
      const totalLines = this.calculateTotalLines(prData.files);
      await prisma.analysis.update({
        where: { id: analysisId },
        data: { totalLines },
      });

      // Step 3: Analyze with OpenAI
      console.log("Starting AI analysis...");
      const aiAnalysis = await openaiService.analyzeCode(prData);

      // Step 4: Save suggestions to database
      console.log("Saving suggestions to database...");
      await this.saveSuggestions(analysisId, aiAnalysis.suggestions);

      // Step 5: Mark as completed
      await this.updateAnalysisStatus(analysisId, "COMPLETED");

      console.log(
        `Analysis ${analysisId} completed successfully with ${aiAnalysis.suggestions.length} suggestions`
      );

      // Invalidate relevant caches
      await this.invalidateAnalysisCache(analysisId, analysis.userId);

      return {
        success: true,
        analysisId,
        suggestionCount: aiAnalysis.suggestions.length,
        summary: aiAnalysis.summary,
      };
    } catch (error) {
      console.error(`Analysis ${analysisId} failed:`, error);

      // Mark analysis as failed
      if (analysis) {
        await this.updateAnalysisStatus(analysisId, "FAILED");

        // Save error as a suggestion for debugging
        await this.saveErrorSuggestion(analysisId, error.message);
      }

      throw error;
    }
  }

  // Save suggestions to database
  async saveSuggestions(analysisId, suggestions) {
    try {
      if (!suggestions || suggestions.length === 0) {
        console.log("No suggestions to save");
        return [];
      }

      const suggestionData = suggestions.map((suggestion) => ({
        analysisId,
        filePath: suggestion.filePath,
        lineNumber: suggestion.lineNumber,
        severity: suggestion.severity,
        category: suggestion.category,
        message: suggestion.message,
        suggestion: suggestion.suggestion,
        codeSnippet: suggestion.codeSnippet,
      }));

      const savedSuggestions = await prisma.suggestion.createMany({
        data: suggestionData,
      });

      console.log(
        `Saved ${savedSuggestions.count} suggestions for analysis ${analysisId}`
      );
      return savedSuggestions;
    } catch (error) {
      console.error("Failed to save suggestions:", error);
      throw new Error("Failed to save analysis suggestions");
    }
  }

  // Update analysis status
  async updateAnalysisStatus(analysisId, status) {
    try {
      const updateData = {
        status,
        ...(status === "COMPLETED" && { completedAt: new Date() }),
      };

      const updatedAnalysis = await prisma.analysis.update({
        where: { id: analysisId },
        data: updateData,
      });

      console.log(`Analysis ${analysisId} status updated to ${status}`);

      // Invalidate status cache
      await redis.del(`analysis:status:${analysisId}`);

      return updatedAnalysis;
    } catch (error) {
      console.error("Failed to update analysis status:", error);
      throw new Error("Failed to update analysis status");
    }
  }

  // Get user's analyses with pagination
  async getUserAnalyses(userId, options = {}) {
    const {
      page = 1,
      limit = 10,
      status = null,
      repositoryId = null,
    } = options;

    try {
      // Build cache key
      const cacheKey = `analyses:user:${userId}:${page}:${limit}:${status}:${repositoryId}`;
      const cached = await redis.get(cacheKey);

      if (cached) {
        console.log("Using cached user analyses");
        return JSON.parse(cached);
      }

      // Build where clause
      const where = {
        userId,
        ...(status && { status }),
        ...(repositoryId && { repositoryId }),
      };

      const skip = (parseInt(page) - 1) * parseInt(limit);

      // Get analyses and count
      const [analyses, total] = await Promise.all([
        prisma.analysis.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take: parseInt(limit),
          include: {
            repository: {
              select: {
                id: true,
                name: true,
                fullName: true,
              },
            },
            _count: {
              select: {
                suggestions: true,
              },
            },
          },
        }),
        prisma.analysis.count({ where }),
      ]);

      // Transform data
      const transformedAnalyses = analyses.map((analysis) => ({
        id: analysis.id,
        repositoryId: analysis.repositoryId,
        prNumber: analysis.prNumber,
        status: analysis.status,
        createdAt: analysis.createdAt,
        completedAt: analysis.completedAt,
        repository: analysis.repository,
        suggestionCount: analysis._count.suggestions,
        duration: this.calculateDuration(
          analysis.createdAt,
          analysis.completedAt
        ),
      }));

      const result = {
        analyses: transformedAnalyses,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
        },
      };

      // Cache for 5 minutes
      await redis.setex(cacheKey, 300, JSON.stringify(result));

      return result;
    } catch (error) {
      console.error("Failed to get user analyses:", error);
      throw new Error("Failed to retrieve user analyses");
    }
  }

  // Get analysis status (lightweight)
  async getAnalysisStatus(analysisId, userId) {
    try {
      const cacheKey = `analysis:status:${analysisId}`;
      const cached = await redis.get(cacheKey);

      if (cached) {
        return JSON.parse(cached);
      }

      const analysis = await prisma.analysis.findFirst({
        where: {
          id: analysisId,
          userId,
        },
        select: {
          id: true,
          status: true,
          createdAt: true,
          completedAt: true,
          _count: {
            select: {
              suggestions: true,
            },
          },
        },
      });

      if (!analysis) {
        throw new NotFoundError("Analysis not found");
      }

      const statusData = {
        id: analysis.id,
        status: analysis.status,
        createdAt: analysis.createdAt,
        completedAt: analysis.completedAt,
        suggestionCount: analysis._count.suggestions,
        duration: this.calculateDuration(
          analysis.createdAt,
          analysis.completedAt
        ),
      };

      // Cache for 1 minute (status changes frequently during processing)
      await redis.setex(cacheKey, 60, JSON.stringify(statusData));

      return statusData;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      console.error("Failed to get analysis status:", error);
      throw new Error("Failed to get analysis status");
    }
  }

  // Helper: Calculate total lines in PR
  calculateTotalLines(files) {
    return files.reduce((total, file) => {
      return total + (file.additions || 0) + (file.deletions || 0);
    }, 0);
  }

  // Helper: Generate analysis summary
  generateAnalysisSummary(suggestions) {
    const total = suggestions.length;
    const high = suggestions.filter((s) => s.severity === "HIGH").length;
    const medium = suggestions.filter((s) => s.severity === "MEDIUM").length;
    const low = suggestions.filter((s) => s.severity === "LOW").length;

    // Get category breakdown
    const categories = suggestions.reduce((acc, suggestion) => {
      acc[suggestion.category] = (acc[suggestion.category] || 0) + 1;
      return acc;
    }, {});

    return {
      totalSuggestions: total,
      severityBreakdown: {
        high,
        medium,
        low,
      },
      categoryBreakdown: categories,
    };
  }

  // Helper: Calculate analysis duration
  calculateDuration(startTime, endTime) {
    if (!endTime) return null;

    const start = new Date(startTime);
    const end = new Date(endTime);
    const diffMs = end - start;

    return Math.round(diffMs / 1000); // Duration in seconds
  }

  // Helper: Save error as suggestion for debugging
  async saveErrorSuggestion(analysisId, errorMessage) {
    try {
      await prisma.suggestion.create({
        data: {
          analysisId,
          filePath: "analysis-error",
          lineNumber: 1,
          severity: "HIGH",
          category: "Analysis Error",
          message: "Analysis failed to complete",
          suggestion: `Error: ${errorMessage}`,
          codeSnippet: null,
        },
      });
    } catch (error) {
      console.error("Failed to save error suggestion:", error);
    }
  }

  // Helper: Invalidate analysis caches
  async invalidateAnalysisCache(analysisId, userId) {
    try {
      // Clear specific analysis cache
      await redis.del(`analysis:full:${analysisId}`);
      await redis.del(`analysis:status:${analysisId}`);

      // Clear user analyses cache
      const userCacheKeys = await redis.keys(`analyses:user:${userId}:*`);
      if (userCacheKeys.length > 0) {
        await redis.del(...userCacheKeys);
      }

      console.log("Invalidated analysis caches");
    } catch (error) {
      console.error("Failed to invalidate cache:", error);
    }
  }
}

module.exports = new AnalysisService();
