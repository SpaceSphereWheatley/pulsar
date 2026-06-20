.PHONY: install run test lint docker-build docker-run

install:
	pip install -r requirements.txt -r requirements-dev.txt

run:
	uvicorn server.main:app --reload --port 8000

test:
	pytest

lint:
	ruff check server/
	ruff format --check server/

docker-build:
	docker build -t pulsar .

docker-run:
	docker run --rm -p 8000:8000 --env-file .env pulsar
