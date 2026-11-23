FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && addgroup --system liftline \
    && adduser --system --ingroup liftline liftline \
    && mkdir -p /data \
    && chown liftline:liftline /data

COPY --chown=liftline:liftline . .

ENV APP_ENV=production
ENV DATABASE_PATH=/data/liftline.sqlite
ENV PORT=8000
EXPOSE 8000
USER liftline

CMD ["sh", "-c", "waitress-serve --listen=0.0.0.0:${PORT} app:app"]
