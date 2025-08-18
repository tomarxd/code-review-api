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
- **Testing**: Jest, Supertest

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
   git clone <your-repo-url>
   cd code-review-api