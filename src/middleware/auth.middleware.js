const jwt = require('jsonwebtoken');
const redis = require('../config/redis');
const { AuthenticationError } = require('../utils/errors');

const authMiddleware = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthenticationError('No token provided');
    }

    const token = authHeader.substring(7); // Remove "Bearer "

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Optional: Check if session exists in Redis
    const session = await redis.get(`session:${decoded.userId}`);
    if (!session) {
      throw new AuthenticationError('Session expired');
    }

    // Add user info to request object
    req.user = {
      userId: decoded.userId,
      githubId: decoded.githubId,
      username: decoded.username
    };

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return next(new AuthenticationError('Token expired'));
    }
    if (error.name === 'JsonWebTokenError') {
      return next(new AuthenticationError('Invalid token'));
    }
    next(error);
  }
};

module.exports = authMiddleware;