#Base Image
FROM ghcr.io/hsj51/aria-telegram-mirror-bot:master

WORKDIR /bot/

CMD ["bash", "start.sh"]
