FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && apt-get update \
    && apt-get install --no-install-recommends -y gosu \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system liftline \
    && adduser --system --ingroup liftline liftline \
    && mkdir -p /data \
    && chown liftline:liftline /data

COPY --chown=liftline:liftline . .
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV APP_ENV=production
ENV DATABASE_PATH=/data/liftline.sqlite
ENV PORT=8000
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

CMD ["sh", "-c", "waitress-serve --listen=0.0.0.0:${PORT} app:app"]
