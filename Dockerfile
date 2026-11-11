FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 YOUTUBE_MCP_BIND=0.0.0.0
WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
RUN pip install --no-cache-dir . && useradd --uid 10001 --create-home mcp
USER 10001
EXPOSE 8000
CMD ["python", "-c", "from youtube_mcp.remote import main; main()"]
