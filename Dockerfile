#Base Image
FROM ghcr.io/hsj51/aria-telegram-mirror-bot:main

WORKDIR /bot/

CMD ["bash", "start.sh"]
