const OpenAI = require('openai');
const crypto = require('crypto');
const redis = require('../config/redis');

class OpenAIService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    
    // Configuration
    this.model = 'gpt-4o'; // Latest GPT-4 model
    this.maxTokens = 4000;
    this.temperature = 0.1; // Low temperature for consistent, focused responses
  }

  async analyzeCode(prData) {
    const contentHash = this.generateContentHash(prData);
    const cacheKey = `ai:analysis:${contentHash}`;
    
    try {
      // Check cache first
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log('Using cached AI analysis');
        return JSON.parse(cached);
      }

      console.log('Starting AI code analysis...');
      
      // Build the analysis prompt
      const prompt = this.buildAnalysisPrompt(prData);
      
      // Call OpenAI API
      const completion = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content: this.getSystemPrompt()
          },
          {
            role: "user",
            content: prompt
          }
        ],
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        response_format: { type: "json_object" }
      });

      const response = completion.choices[0].message.content;
      console.log('Raw OpenAI response received');
      
      // Parse and validate response
      const analysis = this.parseAndValidateResponse(response);
      
      // Cache for 24 hours
      await redis.setex(cacheKey, 86400, JSON.stringify(analysis));
      
      console.log(`Analysis completed: ${analysis.suggestions.length} suggestions generated`);
      return analysis;
      
    } catch (error) {
      console.error('OpenAI API error:', error);
      
      // Handle specific OpenAI errors
      if (error.code === 'rate_limit_exceeded') {
        throw new Error('OpenAI rate limit exceeded. Please try again later.');
      }
      
      if (error.code === 'insufficient_quota') {
        throw new Error('OpenAI API quota exceeded. Please check your billing.');
      }
      
      if (error.code === 'invalid_request_error') {
        throw new Error('Invalid request to OpenAI API. The code might be too large.');
      }
      
      throw new Error(`Failed to analyze code with AI: ${error.message}`);
    }
  }

  getSystemPrompt() {
    return `You are an expert code reviewer with deep knowledge of software engineering best practices, security, performance, and maintainability.

Your task is to analyze pull request changes and provide constructive, actionable feedback.

IMPORTANT: You must respond with valid JSON in this exact format:
{
  "summary": {
    "totalIssues": number,
    "criticalIssues": number,
    "overallRating": "excellent|good|needs_improvement|poor",
    "mainConcerns": ["concern1", "concern2"]
  },
  "suggestions": [
    {
      "filePath": "path/to/file.js",
      "lineNumber": 42,
      "severity": "HIGH|MEDIUM|LOW",
      "category": "Security|Performance|Code Quality|Best Practices|Bug Risk|Maintainability",
      "message": "Brief description of the issue",
      "suggestion": "Detailed suggestion for improvement",
      "codeSnippet": "problematic code if applicable"
    }
  ]
}

Focus on:
- Security vulnerabilities
- Performance issues
- Code quality and maintainability
- Best practices violations
- Potential bugs
- Design patterns and architecture

Be constructive and specific. Provide actionable suggestions, not just criticism.`;
  }

  buildAnalysisPrompt(prData) {
    const { pr, files } = prData;
    
    // Build context about the PR
    let prompt = `Please analyze this pull request:

## Pull Request Context
- **Title**: ${pr.title}
- **Description**: ${pr.body || 'No description provided'}
- **Changes**: ${pr.additions} additions, ${pr.deletions} deletions across ${pr.changed_files} files

## File Changes to Analyze:

`;

    // Add each file's changes
    files.forEach((file, index) => {
      if (index >= 10) return; // Limit to first 10 files to avoid token limits
      
      prompt += `### File: ${file.filename}
**Status**: ${file.status}
**Changes**: +${file.additions} -${file.deletions}

`;

      // Add the actual diff/patch content
      if (file.patch) {
        // Truncate very long patches to avoid token limits
        const truncatedPatch = file.patch.length > 2000 
          ? file.patch.substring(0, 2000) + '\n... (truncated)'
          : file.patch;
          
        prompt += `**Code Changes**:
\`\`\`diff
${truncatedPatch}
\`\`\`

`;
      }
    });

    // Add analysis instructions
    prompt += `
## Analysis Instructions

Please analyze the above code changes and provide:

1. **Overall Assessment**: Rate the code quality and identify main concerns
2. **Specific Issues**: Find problems in the code with exact line references
3. **Improvement Suggestions**: Provide actionable recommendations

Focus on critical issues first, then important quality improvements.

Remember to respond with valid JSON only.`;

    return prompt;
  }

  parseAndValidateResponse(response) {
    try {
      const analysis = JSON.parse(response);
      
      // Validate response structure
      if (!analysis.summary || !analysis.suggestions) {
        throw new Error('Invalid response structure from OpenAI');
      }
      
      // Validate summary structure
      const summary = analysis.summary;
      if (typeof summary.totalIssues !== 'number' || 
          typeof summary.criticalIssues !== 'number' ||
          !summary.overallRating || 
          !Array.isArray(summary.mainConcerns)) {
        throw new Error('Invalid summary structure in OpenAI response');
      }
      
      // Validate and clean suggestions
      const validSuggestions = analysis.suggestions
        .filter(this.isValidSuggestion)
        .map(this.cleanSuggestion);
      
      // Update counts based on actual valid suggestions
      const criticalCount = validSuggestions.filter(s => s.severity === 'HIGH').length;
      
      return {
        summary: {
          totalIssues: validSuggestions.length,
          criticalIssues: criticalCount,
          overallRating: summary.overallRating,
          mainConcerns: summary.mainConcerns.slice(0, 5) // Limit to 5 main concerns
        },
        suggestions: validSuggestions
      };
      
    } catch (error) {
      console.error('Failed to parse OpenAI response:', error);
      console.error('Raw response:', response);
      
      // Return fallback analysis
      return this.getFallbackAnalysis();
    }
  }

  isValidSuggestion(suggestion) {
    return suggestion &&
           typeof suggestion.filePath === 'string' &&
           typeof suggestion.lineNumber === 'number' &&
           ['HIGH', 'MEDIUM', 'LOW'].includes(suggestion.severity) &&
           typeof suggestion.category === 'string' &&
           typeof suggestion.message === 'string' &&
           typeof suggestion.suggestion === 'string';
  }

  cleanSuggestion(suggestion) {
    return {
      filePath: suggestion.filePath.trim(),
      lineNumber: Math.max(1, parseInt(suggestion.lineNumber) || 1),
      severity: suggestion.severity.toUpperCase(),
      category: suggestion.category.trim(),
      message: suggestion.message.trim().substring(0, 200), // Limit message length
      suggestion: suggestion.suggestion.trim().substring(0, 500), // Limit suggestion length
      codeSnippet: suggestion.codeSnippet ? 
        suggestion.codeSnippet.trim().substring(0, 300) : null
    };
  }

  getFallbackAnalysis() {
    return {
      summary: {
        totalIssues: 1,
        criticalIssues: 0,
        overallRating: 'needs_improvement',
        mainConcerns: ['Analysis failed - please try again']
      },
      suggestions: [{
        filePath: 'analysis-error',
        lineNumber: 1,
        severity: 'MEDIUM',
        category: 'Analysis Error',
        message: 'Failed to analyze code properly',
        suggestion: 'The AI analysis encountered an error. Please try analyzing this PR again.',
        codeSnippet: null
      }]
    };
  }

  generateContentHash(prData) {
    // Create a hash based on PR content for caching
    const content = JSON.stringify({
      prNumber: prData.pr.number,
      title: prData.pr.title,
      files: prData.files.map(f => ({
        filename: f.filename,
        status: f.status,
        patch: f.patch
      }))
    });
    
    return crypto.createHash('md5').update(content).digest('hex');
  }

  // Helper method to estimate token count (rough estimation)
  estimateTokenCount(text) {
    // Rough estimation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  // Method to check if content might exceed token limits
  shouldTruncateContent(prData) {
    const totalContent = JSON.stringify(prData);
    const estimatedTokens = this.estimateTokenCount(totalContent);
    
    // Leave buffer for system prompt and response
    return estimatedTokens > 12000; // Conservative limit
  }

  // Method to truncate content if needed
  truncateIfNeeded(prData) {
    if (!this.shouldTruncateContent(prData)) {
      return prData;
    }

    console.log('Truncating content due to token limits...');
    
    // Limit number of files
    const limitedFiles = prData.files.slice(0, 8);
    
    // Truncate patches
    const truncatedFiles = limitedFiles.map(file => ({
      ...file,
      patch: file.patch ? 
        (file.patch.length > 1500 ? 
          file.patch.substring(0, 1500) + '\n... (truncated)' : 
          file.patch) : 
        file.patch
    }));

    return {
      ...prData,
      files: truncatedFiles
    };
  }

  // Method to get API usage stats (useful for monitoring)
  async getUsageStats() {
    try {
      // This would need to be tracked separately as OpenAI doesn't provide
      // real-time usage stats through the API
      const cacheKeys = await redis.keys('ai:analysis:*');
      
      return {
        cachedAnalyses: cacheKeys.length,
        // Add more stats as needed
      };
    } catch (error) {
      console.error('Failed to get usage stats:', error);
      return { cachedAnalyses: 0 };
    }
  }
}

module.exports = new OpenAIService();