const prisma = require('../config/database');
const redis = require('../config/redis');
const githubService = require('../services/github.service');
const ApiResponse = require('../utils/response');
const { NotFoundError, ValidationError, AuthorizationError } = require('../utils/errors');

class RepositoryController {
  async getRepositories(req, res, next) {
    try {
      const userId = req.user.userId;
      const { page = 1, limit = 10 } = req.query;
      
      // Check Redis cache first
      const cacheKey = `repos:${userId}:${page}:${limit}`;
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        console.log('Using cached repositories');
        return ApiResponse.success(res, JSON.parse(cached));
      }

      // Query repositories from database with pagination
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const [repositories, total] = await Promise.all([
        prisma.repository.findMany({
          where: { 
            userId: userId,
            isActive: true
          },
          orderBy: { updatedAt: 'desc' },
          skip: skip,
          take: parseInt(limit),
          include: {
            _count: {
              select: {
                analyses: true
              }
            }
          }
        }),
        prisma.repository.count({
          where: { 
            userId: userId,
            isActive: true
          }
        })
      ]);

      const result = {
        repositories: repositories.map(repo => ({
          id: repo.id,
          name: repo.name,
          fullName: repo.fullName,
          isActive: repo.isActive,
          createdAt: repo.createdAt,
          updatedAt: repo.updatedAt,
          analysisCount: repo._count.analyses
        })),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: total,
          totalPages: Math.ceil(total / parseInt(limit))
        }
      };

      // Cache for 5 minutes
      await redis.setex(cacheKey, 300, JSON.stringify(result));
      
      ApiResponse.success(res, result);
      
    } catch (error) {
      next(error);
    }
  }

  async createRepository(req, res, next) {
    try {
      const { fullName } = req.body;
      const userId = req.user.userId;
      
      // Verify repository access with GitHub
      const accessCheck = await githubService.verifyRepoAccess(fullName, userId);
      
      if (!accessCheck.hasAccess) {
        throw new AuthorizationError(accessCheck.error || 'No access to this repository');
      }

      // Check if repository already exists for this user
      const existingRepo = await prisma.repository.findFirst({
        where: {
          fullName: fullName,
          userId: userId
        }
      });

      if (existingRepo) {
        if (existingRepo.isActive) {
          throw new ValidationError('Repository is already connected');
        } else {
          // Reactivate if it was deactivated
          const reactivatedRepo = await prisma.repository.update({
            where: { id: existingRepo.id },
            data: { 
              isActive: true,
              updatedAt: new Date()
            }
          });

          // Invalidate user repositories cache
          await this.invalidateRepositoryCache(userId);

          return ApiResponse.success(res, {
            id: reactivatedRepo.id,
            fullName: reactivatedRepo.fullName,
            name: reactivatedRepo.name,
            isActive: reactivatedRepo.isActive
          }, 'Repository reactivated successfully');
        }
      }

      // Create new repository record
      const repository = await prisma.repository.create({
        data: {
          name: accessCheck.repo.name,
          fullName: accessCheck.repo.full_name,
          userId: userId,
          isActive: true
        }
      });

      // Invalidate user repositories cache
      await this.invalidateRepositoryCache(userId);
      
      ApiResponse.created(res, {
        id: repository.id,
        fullName: repository.fullName,
        name: repository.name,
        isActive: repository.isActive,
        createdAt: repository.createdAt
      }, 'Repository connected successfully');
      
    } catch (error) {
      next(error);
    }
  }

  async getRepository(req, res, next) {
    try {
      const { id } = req.params;
      const userId = req.user.userId;
      
      // Check cache first
      const cacheKey = `repo:${id}:${userId}`;
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        console.log('Using cached repository details');
        return ApiResponse.success(res, JSON.parse(cached));
      }

      // Verify user owns repository and get details
      const repository = await prisma.repository.findFirst({
        where: {
          id: id,
          userId: userId,
          isActive: true
        },
        include: {
          analyses: {
            orderBy: { createdAt: 'desc' },
            take: 5, // Latest 5 analyses
            select: {
              id: true,
              prNumber: true,
              status: true,
              createdAt: true,
              completedAt: true,
              _count: {
                select: {
                  suggestions: true
                }
              }
            }
          },
          _count: {
            select: {
              analyses: true
            }
          }
        }
      });

      if (!repository) {
        throw new NotFoundError('Repository not found');
      }

      const result = {
        id: repository.id,
        name: repository.name,
        fullName: repository.fullName,
        isActive: repository.isActive,
        createdAt: repository.createdAt,
        updatedAt: repository.updatedAt,
        totalAnalyses: repository._count.analyses,
        recentAnalyses: repository.analyses.map(analysis => ({
          id: analysis.id,
          prNumber: analysis.prNumber,
          status: analysis.status,
          createdAt: analysis.createdAt,
          completedAt: analysis.completedAt,
          suggestionCount: analysis._count.suggestions
        }))
      };

      // Cache for 10 minutes
      await redis.setex(cacheKey, 600, JSON.stringify(result));
      
      ApiResponse.success(res, result);
      
    } catch (error) {
      next(error);
    }
  }

  async deleteRepository(req, res, next) {
    try {
      const { id } = req.params;
      const userId = req.user.userId;
      
      // Verify user owns repository
      const repository = await prisma.repository.findFirst({
        where: {
          id: id,
          userId: userId
        }
      });

      if (!repository) {
        throw new NotFoundError('Repository not found');
      }

      // Soft delete - set isActive to false instead of hard delete
      // This preserves analysis history
      await prisma.repository.update({
        where: { id: id },
        data: { 
          isActive: false,
          updatedAt: new Date()
        }
      });

      // Invalidate caches
      await this.invalidateRepositoryCache(userId);
      await redis.del(`repo:${id}:${userId}`);
      
      ApiResponse.success(res, null, 'Repository disconnected successfully');
      
    } catch (error) {
      next(error);
    }
  }

  // Get pull requests for a repository
  async getRepositoryPullRequests(req, res, next) {
    try {
      const { id } = req.params;
      const { state = 'open', page = 1 } = req.query;
      const userId = req.user.userId;
      
      // Verify user owns repository
      const repository = await prisma.repository.findFirst({
        where: {
          id: id,
          userId: userId,
          isActive: true
        }
      });

      if (!repository) {
        throw new NotFoundError('Repository not found');
      }

      // Get pull requests from GitHub
      const pullRequests = await githubService.getPullRequests(
        repository.fullName, 
        userId, 
        state, 
        parseInt(page)
      );
      
      ApiResponse.success(res, {
        repository: {
          id: repository.id,
          fullName: repository.fullName
        },
        pullRequests: pullRequests,
        pagination: {
          page: parseInt(page),
          state: state
        }
      });
      
    } catch (error) {
      next(error);
    }
  }

  // Helper method to invalidate repository cache
  async invalidateRepositoryCache(userId) {
    const keys = await redis.keys(`repos:${userId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}

module.exports = new RepositoryController();