const jwt = require("jsonwebtoken");
const axios = require("axios");
const prisma = require("../config/database");
const redis = require("../config/redis");
const ApiResponse = require("../utils/response");
const { AuthenticationError, NotFoundError } = require("../utils/errors");

class AuthController {
  async githubLogin(req, res, next) {
    try {
      const { code } = req.body;

      // Step 1: Exchange code for GitHub access token
      const tokenResponse = await axios.post(
        "https://github.com/login/oauth/access_token",
        {
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code: code,
        },
        {
          headers: {
            Accept: "application/json",
          },
        }
      );

      const accessToken = tokenResponse.data.access_token;

      if (!accessToken) {
        throw new AuthenticationError("Failed to get access token from GitHub");
      }

      // Step 2: Get user info from GitHub
      const userResponse = await axios.get("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      });

      const githubUser = userResponse.data;

      // Step 3: Create or update user in database
      const user = await prisma.user.upsert({
        where: { githubId: githubUser.id.toString() },
        update: {
          email: githubUser.email || `${githubUser.login}@github.local`,
          username: githubUser.login,
          avatar: githubUser.avatar_url,
          updatedAt: new Date(),
        },
        create: {
          email: githubUser.email || `${githubUser.login}@github.local`,
          username: githubUser.login,
          githubId: githubUser.id.toString(),
          avatar: githubUser.avatar_url,
        },
      });

      // Step 4: Generate JWT token
      const jwtPayload = {
        userId: user.id,
        githubId: user.githubId,
        username: user.username,
      };

      const token = jwt.sign(jwtPayload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || "7d",
      });

      // Step 5: Store session in Redis (expires same time as JWT)
      const sessionData = {
        userId: user.id,
        githubToken: accessToken, // Store GitHub token for API calls
        username: user.username,
        loginAt: new Date().toISOString(),
      };

      await redis.setex(
        `session:${user.id}`,
        7 * 24 * 60 * 60, // 7 days in seconds
        JSON.stringify(sessionData)
      );

      // Return success response
      ApiResponse.success(
        res,
        {
          token,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            avatar: user.avatar,
          },
        },
        "Login successful"
      );
    } catch (error) {
      console.error(
        "GitHub login error:",
        error.response?.data || error.message
      );

      if (error.response?.status === 400) {
        return next(
          new AuthenticationError("Invalid GitHub authorization code")
        );
      }

      next(error);
    }
  }

  async refreshToken(req, res, next) {
    try {
      const { token } = req.body;

      // Verify old token (ignore expiration)
      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        ignoreExpiration: true,
      });

      // Check if user still exists
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
      });

      if (!user) {
        throw new AuthenticationError("User not found");
      }

      // Check if session exists in Redis
      const session = await redis.get(`session:${user.id}`);
      if (!session) {
        throw new AuthenticationError("Session expired");
      }

      // Generate new token
      const jwtPayload = {
        userId: user.id,
        githubId: user.githubId,
        username: user.username,
      };

      const newToken = jwt.sign(jwtPayload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || "7d",
      });

      // Update session timestamp
      const sessionData = JSON.parse(session);
      sessionData.refreshedAt = new Date().toISOString();

      await redis.setex(
        `session:${user.id}`,
        7 * 24 * 60 * 60, // 7 days
        JSON.stringify(sessionData)
      );

      ApiResponse.success(
        res,
        {
          token: newToken,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            avatar: user.avatar,
          },
        },
        "Token refreshed successfully"
      );
    } catch (error) {
      if (error.name === "JsonWebTokenError") {
        return next(new AuthenticationError("Invalid token format"));
      }
      next(error);
    }
  }

  async getCurrentUser(req, res, next) {
    try {
      const userId = req.user.userId;

      // Check Redis cache first
      const cacheKey = `user:${userId}`;
      const cachedUser = await redis.get(cacheKey);

      if (cachedUser) {
        console.log("Using cached user data");
        return ApiResponse.success(res, JSON.parse(cachedUser));
      }

      // Query user from database if not cached
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          email: true,
          avatar: true,
          createdAt: true,
          _count: {
            select: {
              repositories: true,
              analyses: true,
            },
          },
        },
      });

      if (!user) {
        throw new NotFoundError("User not found");
      }

      // Cache result for 1 hour
      await redis.setex(cacheKey, 3600, JSON.stringify(user));

      ApiResponse.success(res, user);
    } catch (error) {
      next(error);
    }
  }

  async logout(req, res, next) {
    try {
      const userId = req.user.userId;

      // Remove session from Redis
      await redis.del(`session:${userId}`);

      // Invalidate user cache
      await redis.del(`user:${userId}`);

      // Invalidate user repositories cache
      await redis.del(`repos:${userId}`);

      ApiResponse.success(res, null, "Logged out successfully");
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AuthController();
