FROM jrottenberg/ffmpeg
CMD ffmpeg -re -i "https://drive.google.com/uc?export=download&id=1DUjGA6oEpY5aelF6YRfwufW3pTtAGq2E" -i "https://drive.google.com/uc?export=download&id=1V0guvEykz7dDdjRyoQsjbHr0EWg90cQW" -map 0:v -map 1:a -c:v libx264 -b:v 1000k -c:a aac -b:a 128k -shortest -f flv rtmp://live.restream.io/live/re_11610540_event643ece2ee10141e2b64b6cb89ebb01dd
