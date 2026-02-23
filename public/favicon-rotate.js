(function () {
  const source = '/public/rondo_logo.svg';
  const size = 64;
  const intervalMs = 100;
  const degreesPerSecond = 18; // 20s per full rotation
  const stepDegrees = (degreesPerSecond * intervalMs) / 1000;

  function ensureFaviconLink() {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/png';
    return link;
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const iconLink = ensureFaviconLink();
  const image = new Image();
  let angle = 0;

  function draw() {
    if (document.hidden) return;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.drawImage(image, -size / 2, -size / 2, size, size);
    ctx.restore();

    iconLink.href = canvas.toDataURL('image/png');
    angle = (angle + stepDegrees) % 360;
  }

  image.onload = function () {
    draw();
    setInterval(draw, intervalMs);
  };

  image.src = source;
})();
