# Code Review Assistant API

An AI-powered backend service that analyzes GitHub pull requests and provides intelligent code review suggestions using OpenAI's GPT-4.

## Features

- 🔐 **GitHub OAuth Authentication** - Secure login with GitHub
- 📁 **Repository Management** - Connect and manage GitHub repositories
- 🤖 **AI Code Analysis** - Intelligent PR analysis using OpenAI GPT-4
- ⚡ **Redis Caching** - Fast response times with intelligent caching
- 🔒 **Secure & Scalable** - JWT authentication, rate limiting, and error handling

## Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL with Prisma ORM
- **Cache**: Redis
- **AI**: OpenAI GPT-4 API
- **Authentication**: JWT with GitHub OAuth

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 15+
- Redis 7+
- GitHub OAuth App
- OpenAI API Key

### Installation

1. **Clone the repository**

   ```bash
   git clone <repo-url>
   cd code-review-api


   ```
   # Code Review Assistant API - Postman Usage Guide
   # Feel free to make a frontend for this project.

## Prerequisites Setup

### 1. Environment Variables

First, ensure your `.env` file has all required variables:

```bash
# Database
DATABASE_URL="postgresql://username:password@localhost:5432/codereviewer"

# Redis
REDIS_URL="redis://localhost:6379"
# OR individual Redis settings:
REDIS_HOST="localhost"
REDIS_PORT=6379
REDIS_PASSWORD=""

# GitHub OAuth
GITHUB_CLIENT_ID="your_github_client_id"
GITHUB_CLIENT_SECRET="your_github_client_secret"

# OpenAI
OPENAI_API_KEY="your_openai_api_key"

# JWT
JWT_SECRET="your_super_secret_jwt_key_here"
JWT_EXPIRES_IN="7d"

# Server
PORT=3000
NODE_ENV="development"
FRONTEND_URL="http://localhost:3000"

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

### 2. Start the Application

```bash
# Install dependencies
npm install

# Run database migrations
npm run db:migrate

# Generate Prisma client
npm run db:generate

# Start the server
npm run dev
```

## Postman Collection Setup

### Environment Variables in Postman

Create a new environment in Postman with these variables:

```
baseURL: http://localhost:3000
token: (will be set after login)
userId: (will be set after login)
repositoryId: (will be set after creating repository)
analysisId: (will be set after creating analysis)
```

---

## API Usage Steps

### Step 1: Health Check

**GET** `{{baseURL}}/health`

**Purpose:** Verify the API is running

**Headers:** None required

**Expected Response:**

```json
{
  "success": true,
  "message": "API is healthy",
  "timestamp": "2025-01-23T10:00:00.000Z",
  "uptime": 123.456
}
```

---

### Step 2: GitHub OAuth Authentication

#### 2.1 Get GitHub Authorization Code

1. Go to: `https://github.com/login/oauth/authorize?client_id=YOUR_GITHUB_CLIENT_ID&scope=repo,user:email`
2. Authorize the application
3. Copy the `code` parameter from the redirect URL

#### 2.2 Login with GitHub

**POST** `{{baseURL}}/api/auth/github`

**Headers:**

```
Content-Type: application/json
```

**Body (JSON):**

```json
{
  "code": "your_github_authorization_code_here"
}
```

**Expected Response:**

```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "user_id_here",
      "username": "your_github_username",
      "email": "your@email.com",
      "avatar": "https://avatars.githubusercontent.com/..."
    }
  }
}
```

**Important:** Save the `token` to your Postman environment variable!

---

### Step 3: Get Current User Info

**GET** `{{baseURL}}/api/auth/me`

**Headers:**

```
Authorization: Bearer {{token}}
```

**Expected Response:**

```json
{
  "success": true,
  "data": {
    "id": "user_id",
    "username": "your_username",
    "email": "your@email.com",
    "avatar": "avatar_url",
    "createdAt": "2025-01-23T10:00:00.000Z",
    "_count": {
      "repositories": 0,
      "analyses": 0
    }
  }
}
```

---

### Step 4: Connect a Repository

**POST** `{{baseURL}}/api/repositories`

**Headers:**

```
Authorization: Bearer {{token}}
Content-Type: application/json
```

**Body (JSON):**

```json
{
  "fullName": "yourusername/your-repo-name"
}
```

**Expected Response:**

```json
{
  "success": true,
  "message": "Repository connected successfully",
  "data": {
    "id": "repository_id_here",
    "fullName": "yourusername/your-repo-name",
    "name": "your-repo-name",
    "isActive": true,
    "createdAt": "2025-01-23T10:00:00.000Z"
  }
}
```

**Important:** Save the repository `id` to your Postman environment!

---

### Step 5: Get Connected Repositories

**GET** `{{baseURL}}/api/repositories?page=1&limit=10`

**Headers:**

```
Authorization: Bearer {{token}}
```

**Expected Response:**

```json
{
  "success": true,
  "data": {
    "repositories": [
      {
        "id": "repository_id",
        "name": "repo-name",
        "fullName": "username/repo-name",
        "isActive": true,
        "createdAt": "2025-01-23T10:00:00.000Z",
        "updatedAt": "2025-01-23T10:00:00.000Z",
        "analysisCount": 0
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 1,
      "totalPages": 1
    }
  }
}
```

---

### Step 6: Get Repository Pull Requests

**GET** `{{baseURL}}/api/repositories/{{repositoryId}}/pulls?state=open&page=1`

**Headers:**

```
Authorization: Bearer {{token}}
```

**Expected Response:**

```json
{
  "success": true,
  "data": {
    "repository": {
      "id": "repository_id",
      "fullName": "username/repo-name"
    },
    "pullRequests": [
      {
        "number": 1,
        "title": "Add new feature",
        "body": "This PR adds...",
        "state": "open",
        "user": {
          "login": "username",
          "avatar_url": "avatar_url"
        },
        "created_at": "2025-01-23T09:00:00Z",
        "updated_at": "2025-01-23T09:30:00Z",
        "commits": 3,
        "additions": 150,
        "deletions": 25,
        "changed_files": 5
      }
    ],
    "pagination": {
      "page": 1,
      "state": "open"
    }
  }
}
```

---

### Step 7: Create Code Analysis

**POST** `{{baseURL}}/api/analyses/repositories/{{repositoryId}}/analyze`

**Headers:**

```
Authorization: Bearer {{token}}
Content-Type: application/json
```

**Body (JSON):**

```json
{
  "prNumber": 1
}
```

**Expected Response:**

```json
{
  "success": true,
  "message": "Analysis started successfully",
  "data": {
    "analysisId": "analysis_id_here",
    "status": "PENDING",
    "repositoryName": "repo-name",
    "prNumber": 1,
    "createdAt": "2025-01-23T10:00:00.000Z",
    "estimatedTime": "2-5 minutes"
  }
}
```

**Important:** Save the `analysisId` to your Postman environment!

---

### Step 8: Check Analysis Status

**GET** `{{baseURL}}/api/analyses/{{analysisId}}`

**Headers:**

```
Authorization: Bearer {{token}}
```

**Response (PENDING/PROCESSING):**

```json
{
  "success": true,
  "data": {
    "id": "analysis_id",
    "status": "PROCESSING",
    "createdAt": "2025-01-23T10:00:00.000Z",
    "completedAt": null,
    "suggestions": []
  }
}
```

**Response (COMPLETED):**

```json
{
  "success": true,
  "message": "Analysis retrieved successfully",
  "data": {
    "id": "analysis_id",
    "repository": {
      "id": "repo_id",
      "name": "repo-name",
      "fullName": "username/repo-name"
    },
    "prNumber": 1,
    "commitSha": "abc123...",
    "status": "COMPLETED",
    "totalLines": 175,
    "createdAt": "2025-01-23T10:00:00.000Z",
    "completedAt": "2025-01-23T10:03:00.000Z",
    "suggestions": [
      {
        "id": "suggestion_id",
        "filePath": "src/utils/helper.js",
        "lineNumber": 15,
        "severity": "MEDIUM",
        "category": "Code Quality",
        "message": "Consider using const instead of let",
        "suggestion": "Use const for variables that don't change...",
        "codeSnippet": "let result = processData(input);"
      }
    ],
    "summary": {
      "totalSuggestions": 5,
      "highSeverity": 1,
      "mediumSeverity": 3,
      "lowSeverity": 1,
      "categories": {
        "Code Quality": { "count": 3, "severityBreakdown": {...} },
        "Security": { "count": 2, "severityBreakdown": {...} }
      }
    }
  }
}
```

---

### Step 9: Get User's All Analyses

**GET** `{{baseURL}}/api/analyses?page=1&limit=10&status=COMPLETED&sortBy=createdAt&sortOrder=desc`

**Headers:**

```
Authorization: Bearer {{token}}
```

**Query Parameters:**

- `page`: Page number (default: 1)
- `limit`: Items per page (default: 10, max: 50)
- `status`: Filter by status (PENDING, PROCESSING, COMPLETED, FAILED)
- `repositoryId`: Filter by repository
- `sortBy`: Sort field (createdAt, completedAt, status, prNumber)
- `sortOrder`: Sort direction (asc, desc)

---

### Step 10: Get Analysis Statistics

**GET** `{{baseURL}}/api/analyses/stats`

**Headers:**

```
Authorization: Bearer {{token}}
```

**Expected Response:**

```json
{
  "success": true,
  "message": "Statistics retrieved successfully",
  "data": {
    "overview": {
      "totalAnalyses": 10,
      "completedAnalyses": 8,
      "failedAnalyses": 1,
      "processingAnalyses": 1,
      "successRate": 80
    },
    "suggestions": {
      "totalSuggestions": 45,
      "avgSuggestionsPerAnalysis": 6
    },
    "recentActivity": [
      {
        "id": "analysis_id",
        "repositoryName": "repo-name",
        "prNumber": 1,
        "status": "COMPLETED",
        "createdAt": "2025-01-23T10:00:00.000Z",
        "suggestionsCount": 5,
        "highSeverityCount": 1
      }
    ]
  }
}
```

---

### Step 11: Export Analysis Results

**GET** `{{baseURL}}/api/analyses/{{analysisId}}/export?format=json`

**Headers:**

```
Authorization: Bearer {{token}}
```

**Query Parameters:**

- `format`: Export format (`json` or `csv`)

**Response:** Downloads the analysis data in the requested format.

---

### Step 12: Delete Analysis

**DELETE** `{{baseURL}}/api/analyses/{{analysisId}}`

**Headers:**

```
Authorization: Bearer {{token}}
```

**Expected Response:**

```json
{
  "success": true,
  "message": "Analysis deleted successfully",
  "data": null
}
```

---

### Step 13: Logout

**POST** `{{baseURL}}/api/auth/logout`

**Headers:**

```
Authorization: Bearer {{token}}
```

**Expected Response:**

```json
{
  "success": true,
  "message": "Logged out successfully",
  "data": null
}
```

---

## Advanced Features

### Rerun Failed Analysis

**POST** `{{baseURL}}/api/analyses/{{analysisId}}/rerun`

### Get Only Suggestions (Lightweight)

**GET** `{{baseURL}}/api/analyses/{{analysisId}}/suggestions?severity=HIGH&page=1&limit=20`

### Refresh JWT Token

**POST** `{{baseURL}}/api/auth/refresh`

```json
{
  "token": "your_expired_token"
}
```

---

## Common Error Responses

### Authentication Error (401)

```json
{
  "success": false,
  "error": {
    "message": "No token provided"
  }
}
```

### Rate Limit Error (429)

```json
{
  "success": false,
  "error": {
    "message": "Too many analysis requests. Please wait before creating another analysis.",
    "type": "RATE_LIMIT_EXCEEDED",
    "retryAfter": "15 minutes"
  }
}
```

### Validation Error (400)

```json
{
  "success": false,
  "error": {
    "message": "PR number must be at least 1"
  }
}
```

---
