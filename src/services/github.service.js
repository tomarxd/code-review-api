const axios = require('axios');
const redis = require('../config/redis');

class GitHubService {
  constructor() {
    this.baseURL = 'https://api.github.com';
  }

  // Get GitHub token from Redis session
  async getGithubToken(userId) {
    const session = await redis.get(`session:${userId}`);
    if (!session) {
      throw new Error('User session not found');
    }
    
    const sessionData = JSON.parse(session);
    return sessionData.githubToken;
  }

  // Create authenticated axios instance
  async createAuthenticatedClient(userId) {
    const token = await this.getGithubToken(userId);
    
    return axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CodeReviewAPI/1.0'
      }
    });
  }

  async getPRDiff(repoFullName, prNumber, userId) {
    const cacheKey = `github:diff:${repoFullName}:${prNumber}`;
    
    try {
      // Check cache first
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log('Using cached PR diff');
        return JSON.parse(cached);
      }

      const client = await this.createAuthenticatedClient(userId);
      
      // Get PR information
      const prResponse = await client.get(`/repos/${repoFullName}/pulls/${prNumber}`);
      const pr = prResponse.data;
      
      // Get PR files (the diff)
      const filesResponse = await client.get(`/repos/${repoFullName}/pulls/${prNumber}/files`);
      const files = filesResponse.data;
      
      // Build structured diff data
      const diffData = {
        pr: {
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          commits: pr.commits,
          additions: pr.additions,
          deletions: pr.deletions,
          changed_files: pr.changed_files
        },
        files: files.map(file => ({
          filename: file.filename,
          status: file.status, // added, modified, deleted
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch, // The actual diff content
          blob_url: file.blob_url
        }))
      };
      
      // Cache for 30 minutes
      await redis.setex(cacheKey, 1800, JSON.stringify(diffData));
      
      return diffData;
      
    } catch (error) {
      console.error('GitHub API error:', error.response?.data || error.message);
      
      if (error.response?.status === 404) {
        throw new Error('Pull request not found or no access to repository');
      }
      if (error.response?.status === 403) {
        throw new Error('Access denied to repository or rate limit exceeded');
      }
      
      throw new Error('Failed to fetch PR diff from GitHub');
    }
  }

  async verifyRepoAccess(repoFullName, userId) {
    try {
      const client = await this.createAuthenticatedClient(userId);
      
      // Try to get repository information
      const response = await client.get(`/repos/${repoFullName}`);
      const repo = response.data;
      
      // Check if user has at least read access
      return {
        hasAccess: true,
        repo: {
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          private: repo.private,
          permissions: repo.permissions,
          default_branch: repo.default_branch
        }
      };
      
    } catch (error) {
      console.error('Repository access verification error:', error.response?.data || error.message);
      
      if (error.response?.status === 404) {
        return {
          hasAccess: false,
          error: 'Repository not found or no access'
        };
      }
      
      if (error.response?.status === 403) {
        return {
          hasAccess: false,
          error: 'Access denied to repository'
        };
      }
      
      throw new Error('Failed to verify repository access');
    }
  }

  async getUserRepositories(userId, page = 1, perPage = 30) {
    const cacheKey = `github:user-repos:${userId}:${page}`;
    
    try {
      // Check cache first
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log('Using cached user repositories');
        return JSON.parse(cached);
      }

      const client = await this.createAuthenticatedClient(userId);
      
      // Get user's repositories
      const response = await client.get('/user/repos', {
        params: {
          sort: 'updated',
          direction: 'desc',
          per_page: perPage,
          page: page,
          type: 'all' // all, owner, public, private, member
        }
      });
      
      const repos = response.data.map(repo => ({
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        private: repo.private,
        description: repo.description,
        language: repo.language,
        updated_at: repo.updated_at,
        permissions: repo.permissions
      }));
      
      // Cache for 10 minutes
      await redis.setex(cacheKey, 600, JSON.stringify(repos));
      
      return repos;
      
    } catch (error) {
      console.error('Get user repositories error:', error.response?.data || error.message);
      throw new Error('Failed to fetch user repositories from GitHub');
    }
  }

  async getPullRequests(repoFullName, userId, state = 'open', page = 1, perPage = 10) {
    const cacheKey = `github:prs:${repoFullName}:${state}:${page}`;
    
    try {
      // Check cache first
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log('Using cached pull requests');
        return JSON.parse(cached);
      }

      const client = await this.createAuthenticatedClient(userId);
      
      // Get pull requests
      const response = await client.get(`/repos/${repoFullName}/pulls`, {
        params: {
          state: state, // open, closed, all
          sort: 'updated',
          direction: 'desc',
          per_page: perPage,
          page: page
        }
      });
      
      const prs = response.data.map(pr => ({
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        user: {
          login: pr.user.login,
          avatar_url: pr.user.avatar_url
        },
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        commits: pr.commits,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files
      }));
      
      // Cache for 5 minutes (PRs change frequently)
      await redis.setex(cacheKey, 300, JSON.stringify(prs));
      
      return prs;
      
    } catch (error) {
      console.error('Get pull requests error:', error.response?.data || error.message);
      
      if (error.response?.status === 404) {
        throw new Error('Repository not found or no access');
      }
      
      throw new Error('Failed to fetch pull requests from GitHub');
    }
  }

  // Helper method to check rate limiting
  async getRateLimitStatus(userId) {
    try {
      const client = await this.createAuthenticatedClient(userId);
      const response = await client.get('/rate_limit');
      
      return {
        limit: response.data.rate.limit,
        remaining: response.data.rate.remaining,
        reset: new Date(response.data.rate.reset * 1000),
        used: response.data.rate.limit - response.data.rate.remaining
      };
      
    } catch (error) {
      console.error('Rate limit check error:', error.message);
      return null;
    }
  }
}

module.exports = new GitHubService();