# PULSAR — one-command, cross-platform run.
#   docker build -t pulsar .
#   docker run --rm -p 8000:8000 --env-file .env pulsar
FROM python:3.11-slim

WORKDIR /app

# Install runtime dependencies first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application (server + frontend + configs).
COPY . .

EXPOSE 8000

# Run from the repo root; the frontend mount resolves relative to the package.
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
