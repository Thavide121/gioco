(() => {
  "use strict";

  // ==========================================================
  // Costanti di configurazione
  // ==========================================================
  const PHYSICS = {
    gravity: 1450,            // px/s²
    airDrag: 0.999,           // attrito dell'aria sull'asse x (per frame a 60 fps)
    wallRestitution: 0.78,    // rimbalzo sulle pareti laterali
    ceilingRestitution: 0.65, // rimbalzo sul soffitto
    floorRestitution: 0.72,   // rimbalzo sul pavimento
    floorFriction: 0.94,      // perdita di velocità orizzontale al rimbalzo a terra
    maxSubstepDt: 1 / 240,    // passo massimo di integrazione (evita il tunnelling)
    maxFrameDt: 0.033,        // tetto al delta time del frame
  };

  const PADDLE_HIT = {
    restitution: 0.78,        // elasticità dell'urto palla/cerchio
    momentumTransfer: 0.42,   // quota della velocità del cursore trasferita alla palla
    maxCursorSpeed: 1150,     // limite di velocità del cursore usata nell'urto
    upwardBoost: 100,         // spinta extra verso l'alto sul contatto dal basso
    upwardThreshold: -0.18,   // soglia sulla normale (ny) per attivare la spinta
    maxBallSpeed: 1250,       // velocità massima della palla dopo l'urto
    cooldown: 0.075,          // secondi minimi tra due colpi fisici
    depenetrationGap: 0.2,    // distanza extra per separare i cerchi
  };

  const CURSOR_SMOOTHING = 0.25; // peso della velocità precedente (0 = nessun filtro)

  // Quando la palla resta ferma a terra diventa "dormiente" (intangibile)
  // e si riattiva con il tasto sinistro del mouse.
  const REST = {
    maxSpeed: 40,       // px/s: sotto questa velocità la palla è considerata ferma
    timeToSleep: 0.5,   // secondi di quiete a terra prima di diventare intangibile
    floorTolerance: 1,  // px di distanza dal pavimento per considerarla "a terra"
    wakeJumpSpeed: 950, // px/s: impulso verso l'alto al risveglio
    wakeJumpSpread: 60, // px/s: piccola variazione orizzontale casuale del salto
    dormantAlpha: 0.3,  // opacità della palla dormiente
  };

  // Regole del punteggio.
  // Punti per palleggio = basePoints × moltiplicatore.
  // Il moltiplicatore parte da x1.0 e cresce di multiplierStep a ogni palleggio consecutivo.
  const SCORING = {
    basePoints: 10,
    multiplierStep: 0.1,
    minHitSpeed: 300,  // px/s: velocità minima di impatto perché il palleggio conti
    minInterval: 0.15, // secondi minimi tra due palleggi validi (anti-spam)
  };

  // Bonus "tempo in aria": si somma al moltiplicatore combo.
  // Il tempo conta dall'ultimo contatto con il cerchio (o dall'ultimo rimbalzo su muri/tetto).
  // Dopo `delay` secondi il bonus vale `initial`, poi cresce di `step` ogni `stepInterval` secondi.
  // Vale solo fino al palleggio successivo, poi si azzera.
  const AIR_BONUS = {
    delay: 1.5,
    initial: 0.05,
    step: 0.01,
    stepInterval: 0.1,
  };

  // Trick "giro": un cerchio completo del cursore attorno alla palla, senza toccarla.
  // Punti = basePoints × moltiplicatore attuale (combo + bonus in aria), senza consumare il bonus.
  const TRICK = {
    basePoints: 20,
    minRadiusGap: 6,      // px oltre la distanza di contatto: più vicino = si sta toccando la palla
    maxRadius: 260,       // px: oltre questa distanza il giro non conta
    minPaddleSpeed: 250,  // px/s: il cursore deve muoversi davvero (non basta che si muova la palla)
    idleTimeout: 0.5,     // secondi di cursore troppo lento prima di perdere il progresso
    toleranceDegrees: 10, // gradi mancanti ai 360° con cui il giro vale comunque
    minArcToShow: 0.4,    // rad: sotto questa soglia l'arco di progresso non viene disegnato
    color: "#8a4dff",
  };

  // Sensazioni dell'interfaccia (animazioni "gonfia e rimbalza").
  const FEEL = {
    springStiffness: 220,   // rigidità della molla di scala
    springDamping: 14,      // smorzamento (più basso = più rimbalzo)
    countUpRate: 14,        // velocità con cui il numero mostrato rincorre il punteggio
    scorePopBase: 5,        // impulso base del punteggio a ogni palleggio
    scorePopPerCombo: 0.25, // impulso extra per ogni palleggio di combo
    multiplierPopBase: 7,   // impulso base del moltiplicatore quando sale
    multiplierPopPerCombo: 0.3,
    breakShrink: 6,         // "schiaffo" al moltiplicatore quando la combo si rompe
    trickScorePop: 8,       // "pop" del punteggio al completamento di un giro
    trickRingLife: 0.6,     // durata in secondi dell'onda che parte dalla palla
    trickRingGrow: 130,     // px di espansione dell'onda
    airBonusActivatePop: 6, // "pop" del bonus quando si attiva
    airBonusTickPop: 1.5,   // piccolo "tic" a ogni incremento del bonus
    airConsumePop: 5,       // impulso al moltiplicatore quando il bonus viene incassato
    maxComboForPop: 15,     // oltre questa combo l'intensità non cresce più
    floatingTextLife: 0.9,  // durata in secondi dei "+N" fluttuanti
    floatingTextRise: 70,   // px di salita dei "+N"
  };

  // ==========================================================
  // Riferimenti al DOM
  // ==========================================================
  const canvas = document.querySelector("#game");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.querySelector("#score");
  const multiplierEl = document.querySelector("#multiplier");
  const airBonusEl = document.querySelector("#air-bonus");
  const comboEl = document.querySelector("#combo");
  const bestEl = document.querySelector("#best");
  const resetButton = document.querySelector("#reset");

  // ==========================================================
  // Stato del gioco
  // ==========================================================
  let width = innerWidth;
  let height = innerHeight;
  let lastTimestamp = 0;

  let contactCooldown = 0; // cooldown dell'urto fisico
  let scoreCooldown = 0;   // cooldown tra due palleggi validi
  let restTimer = 0;       // da quanto tempo la palla è ferma a terra
  let isDormant = false;   // true = palla ferma e intangibile

  let score = 0;
  let best = 0;
  let streak = 0;          // palleggi validi consecutivi
  let airTime = 0;         // secondi in aria dall'ultimo contatto
  let airBonus = 0;        // bonus tempo in aria attualmente accumulato

  // Stato visivo del punteggio
  let displayedScore = 0;  // valore che "rincorre" il punteggio reale
  let shownScoreText = "0";
  const scorePop = { value: 0, velocity: 0 };      // molla di scala del punteggio
  const multiplierPop = { value: 0, velocity: 0 }; // molla di scala del moltiplicatore
  const airBonusPop = { value: 0, velocity: 0 };   // molla di scala del bonus in aria
  let floatingTexts = [];                          // "+N" che salgono dopo un palleggio
  let trickRings = [];                             // onde che partono dalla palla dopo un giro

  // Progresso del trick: angolo del cursore attorno alla palla (signed, in radianti).
  const trick = { angle: null, progress: 0, idle: 0 };

  const ball = {
    x: width * 0.5,
    y: height * 0.32,
    vx: 110,
    vy: 0,
    r: 18,
  };

  // Il "paddle" è il cerchio controllato dal mouse.
  // px/py sono la posizione del frame precedente, usata per calcolare la velocità.
  const paddle = {
    x: width * 0.5,
    y: height * 0.65,
    px: width * 0.5,
    py: height * 0.65,
    vx: 0,
    vy: 0,
    r: 48,
  };

  // ==========================================================
  // Utilità
  // ==========================================================
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  // ==========================================================
  // Punteggio
  // ==========================================================

  /** Moltiplicatore in base ai palleggi consecutivi: 1.0, 1.1, 1.2, 1.3... */
  function multiplierForStreak(count) {
    if (count <= 1) return 1;
    return Math.round((1 + SCORING.multiplierStep * (count - 1)) * 100) / 100;
  }

  /** Colore del moltiplicatore: grigio a x1.0, poi sempre più caldo. */
  function comboColor(count) {
    if (count <= 1) return "#9a9a9a";
    const hue = Math.max(0, 48 - (count - 2) * 5);
    return `hsl(${hue} 90% 48%)`;
  }

  /** Dà una spinta a una molla: genererà un "gonfiamento" con rimbalzo. */
  function kick(spring, impulse) {
    spring.velocity += impulse;
  }

  /** Aggiorna testo e colore di moltiplicatore, combo e record. */
  function updateMultiplierUI() {
    const multiplier = multiplierForStreak(streak);
    multiplierEl.textContent = `x${multiplier.toFixed(1)}`;
    multiplierEl.style.setProperty("--mult-color", comboColor(streak));
    multiplierEl.classList.toggle("idle", streak <= 1);
    comboEl.textContent = streak > 1 ? `${streak} palleggi di fila` : "";
    bestEl.textContent = best;
  }

  /** Registra un palleggio valido: punti, combo, animazioni. */
  function registerScoringHit(x, y, bonus) {
    streak += 1;

    // Moltiplicatore totale = combo + bonus tempo in aria.
    const totalMultiplier = multiplierForStreak(streak) + bonus;
    const points = Math.round(SCORING.basePoints * totalMultiplier);
    score += points;
    best = Math.max(best, score);
    scoreCooldown = SCORING.minInterval;

    const intensity = Math.min(streak, FEEL.maxComboForPop);
    kick(scorePop, FEEL.scorePopBase + intensity * FEEL.scorePopPerCombo);
    if (streak > 1) {
      kick(multiplierPop, FEEL.multiplierPopBase + intensity * FEEL.multiplierPopPerCombo);
    }
    if (bonus > 0) kick(multiplierPop, FEEL.airConsumePop);

    floatingTexts.push({
      x,
      y,
      text: `+${points}`,
      color: comboColor(streak),
      size: 20 + intensity * 1.2,
      age: 0,
    });

    updateMultiplierUI();
  }

  /** Interrompe la combo (la palla ha toccato un bordo, il tetto o il pavimento). */
  function breakStreak() {
    if (streak === 0) return;

    if (streak > 1) kick(multiplierPop, -FEEL.breakShrink);
    streak = 0;
    updateMultiplierUI();
  }

  /** Bonus in base ai secondi in aria: 0 prima di `delay`, poi cresce a scatti. */
  function airBonusForTime(seconds) {
    if (seconds < AIR_BONUS.delay) return 0;
    const steps = Math.floor((seconds - AIR_BONUS.delay) / AIR_BONUS.stepInterval + 1e-9);
    return Math.round((AIR_BONUS.initial + AIR_BONUS.step * steps) * 100) / 100;
  }

  /** Mostra o nasconde il bonus tempo in aria. */
  function updateAirBonusUI() {
    airBonusEl.classList.toggle("active", airBonus > 0);
    // Quando il bonus si azzera il testo resta (sfuma in dissolvenza).
    if (airBonus > 0) airBonusEl.textContent = `+${airBonus.toFixed(2)}`;
  }

  /** Fa avanzare il tempo in aria e aggiorna il bonus. */
  function updateAirBonus(frameDt) {
    airTime += frameDt;

    const next = airBonusForTime(airTime);
    if (next === airBonus) return;

    const justActivated = airBonus === 0 && next > 0;
    airBonus = next;
    kick(airBonusPop, justActivated ? FEEL.airBonusActivatePop : FEEL.airBonusTickPop);
    updateAirBonusUI();
  }

  /** Azzera tempo e bonus. `lost` = true se il bonus va perso (muro/tetto/pavimento). */
  function resetAirBonus(lost) {
    if (lost && airBonus > 0) kick(airBonusPop, -FEEL.breakShrink);
    airTime = 0;
    airBonus = 0;
    updateAirBonusUI();
  }

  /** Contatto con muro, tetto o pavimento: si perdono combo e bonus tempo in aria. */
  function onBoundsContact() {
    breakStreak();
    resetAirBonus(true);
  }

  // ==========================================================
  // Trick: giro completo attorno alla palla
  // ==========================================================
  /** Angolo (in radianti) da percorrere per completare il giro, tolleranza inclusa. */
  const TRICK_TARGET_ANGLE = Math.PI * 2 - (TRICK.toleranceDegrees * Math.PI) / 180;

  function resetTrick() {
    trick.angle = null;
    trick.progress = 0;
    trick.idle = 0;
  }

  /** Assegna i punti del giro e lancia gli effetti. */
  function completeTrick() {
    const totalMultiplier = multiplierForStreak(streak) + airBonus;
    const points = Math.round(TRICK.basePoints * totalMultiplier);
    score += points;
    best = Math.max(best, score);

    kick(scorePop, FEEL.trickScorePop);
    floatingTexts.push({
      x: ball.x,
      y: ball.y - ball.r - 14,
      text: `GIRO +${points}`,
      color: TRICK.color,
      size: 30,
      age: 0,
    });
    trickRings.push({ x: ball.x, y: ball.y, age: 0 });

    updateMultiplierUI();
    resetTrick();
  }

  /** Accumula l'angolo del cursore attorno alla palla; a 360° scatta il trick. */
  function updateTrick(frameDt) {
    const dx = paddle.x - ball.x;
    const dy = paddle.y - ball.y;
    const distance = Math.hypot(dx, dy);
    const minRadius = ball.r + paddle.r + TRICK.minRadiusGap;

    // Troppo vicino (contatto) o troppo lontano: il giro si interrompe.
    if (distance < minRadius || distance > TRICK.maxRadius) {
      resetTrick();
      return;
    }

    const angle = Math.atan2(dy, dx);
    if (trick.angle === null) {
      trick.angle = angle; // primo frame: serve solo come riferimento
      return;
    }

    // Variazione d'angolo rispetto al frame precedente, normalizzata in [-π, π].
    let delta = angle - trick.angle;
    if (delta > Math.PI) delta -= Math.PI * 2;
    else if (delta < -Math.PI) delta += Math.PI * 2;
    trick.angle = angle;

    // Il cursore deve muoversi: una palla che gli passa intorno da sola non vale.
    if (Math.hypot(paddle.vx, paddle.vy) < TRICK.minPaddleSpeed) {
      trick.idle += frameDt;
      if (trick.idle > TRICK.idleTimeout) resetTrick();
      return;
    }
    trick.idle = 0;

    // Con segno: invertire la direzione fa tornare indietro il progresso.
    trick.progress += delta;
    if (Math.abs(trick.progress) >= TRICK_TARGET_ANGLE) completeTrick();
  }

  // ==========================================================
  // Setup e input
  // ==========================================================
  function resize() {
    width = innerWidth;
    height = innerHeight;

    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    paddle.x = clamp(paddle.x, paddle.r, width - paddle.r);
    paddle.y = clamp(paddle.y, paddle.r, height - paddle.r);
  }

  function reset() {
    ball.x = width * 0.5;
    ball.y = height * 0.32;
    ball.vx = 70;
    ball.vy = 0;

    paddle.x = width * 0.5;
    paddle.y = height * 0.68;
    paddle.px = paddle.x;
    paddle.py = paddle.y;
    paddle.vx = 0;
    paddle.vy = 0;

    contactCooldown = 0;
    scoreCooldown = 0;
    restTimer = 0;
    isDormant = false;

    score = 0;
    streak = 0;
    displayedScore = 0;
    scorePop.value = scorePop.velocity = 0;
    multiplierPop.value = multiplierPop.velocity = 0;
    floatingTexts = [];
    trickRings = [];
    resetTrick();

    airTime = 0;
    airBonus = 0;
    airBonusPop.value = airBonusPop.velocity = 0;
    airBonusEl.textContent = "+0.00";

    scoreEl.textContent = shownScoreText = "0";
    updateMultiplierUI();
    updateAirBonusUI();
  }

  function setPointer(event) {
    const rect = canvas.getBoundingClientRect();
    paddle.x = event.clientX - rect.left;
    paddle.y = event.clientY - rect.top;
  }

  function onPointerDown(event) {
    setPointer(event);
    // Tasto sinistro: risveglia la palla se è dormiente.
    if (event.button === 0 && isDormant) wakeUp();
  }

  // ==========================================================
  // Fisica
  // ==========================================================

  /** Aggiorna la velocità del cursore, leggermente filtrata per ridurre il jitter. */
  function updatePaddleVelocity(frameDt) {
    const safeDt = Math.max(frameDt, 0.001);
    const rawVx = (paddle.x - paddle.px) / safeDt;
    const rawVy = (paddle.y - paddle.py) / safeDt;

    paddle.vx = paddle.vx * CURSOR_SMOOTHING + rawVx * (1 - CURSOR_SMOOTHING);
    paddle.vy = paddle.vy * CURSOR_SMOOTHING + rawVy * (1 - CURSOR_SMOOTHING);

    paddle.px = paddle.x;
    paddle.py = paddle.y;
  }

  /** Applica l'urto elastico lungo la normale e trasferisce la quantità di moto del cursore. */
  function applyPaddleHit(nx, ny, normalSpeed) {
    const { restitution, momentumTransfer, maxCursorSpeed } = PADDLE_HIT;

    // Il palleggio conta solo se l'impatto è abbastanza veloce
    // (evita punti infiniti con la palla appoggiata sul cerchio).
    const closingSpeed = -normalSpeed;
    const countsForScore =
      closingSpeed >= SCORING.minHitSpeed && scoreCooldown <= 0;

    // Rimbalzo lungo la normale con un po' di perdita di energia.
    ball.vx -= (1 + restitution) * normalSpeed * nx;
    ball.vy -= (1 + restitution) * normalSpeed * ny;

    // Il cursore in movimento cede quantità di moto (con velocità limitata).
    ball.vx += clamp(paddle.vx, -maxCursorSpeed, maxCursorSpeed) * momentumTransfer;
    ball.vy += clamp(paddle.vy, -maxCursorSpeed, maxCursorSpeed) * momentumTransfer;

    // Favorisce i palleggi verso l'alto quando si colpisce con la parte bassa del cerchio.
    if (ny < PADDLE_HIT.upwardThreshold) {
      ball.vy -= PADDLE_HIT.upwardBoost * Math.min(1, -ny);
    }

    // Evita colpi eccessivamente esplosivi.
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > PADDLE_HIT.maxBallSpeed) {
      const scale = PADDLE_HIT.maxBallSpeed / speed;
      ball.vx *= scale;
      ball.vy *= scale;
    }

    contactCooldown = PADDLE_HIT.cooldown;

    // Ogni contatto col cerchio chiude il "volo": il bonus in aria viene incassato
    // dal palleggio (se valido) e il tempo riparte da zero.
    const bonus = airBonus;
    resetAirBonus(false);

    if (countsForScore) registerScoringHit(ball.x, ball.y - ball.r, bonus);
  }

  /** Gestisce la collisione palla/cerchio. Restituisce true se i cerchi si sovrappongono. */
  function collideWithPaddle() {
    const dx = ball.x - paddle.x;
    const dy = ball.y - paddle.y;
    const distance = Math.hypot(dx, dy);
    const minDistance = ball.r + paddle.r;

    if (distance >= minDistance) return false;

    // Toccare la palla interrompe un eventuale giro in corso.
    resetTrick();

    // Normale di collisione (dal cerchio verso la palla).
    const nx = distance < 1e-6 ? 0 : dx / distance;
    const ny = distance < 1e-6 ? -1 : dy / distance;

    // Depenetrazione: riporta la palla esattamente sul perimetro del cerchio.
    const separation = minDistance + PADDLE_HIT.depenetrationGap;
    ball.x = paddle.x + nx * separation;
    ball.y = paddle.y + ny * separation;

    // Conta solo se la palla si sta avvicinando alla superficie (velocità relativa).
    const relVx = ball.vx - paddle.vx;
    const relVy = ball.vy - paddle.vy;
    const normalSpeed = relVx * nx + relVy * ny;

    if (normalSpeed < 0 && contactCooldown <= 0) {
      applyPaddleHit(nx, ny, normalSpeed);
    }
    return true;
  }

  /** Rimbalzi su pareti, soffitto e pavimento. Ogni contatto interrompe la combo. */
  function collideWithBounds() {
    if (ball.x < ball.r) {
      ball.x = ball.r;
      ball.vx = Math.abs(ball.vx) * PHYSICS.wallRestitution;
      onBoundsContact();
    }
    if (ball.x > width - ball.r) {
      ball.x = width - ball.r;
      ball.vx = -Math.abs(ball.vx) * PHYSICS.wallRestitution;
      onBoundsContact();
    }
    if (ball.y < ball.r) {
      ball.y = ball.r;
      ball.vy = Math.abs(ball.vy) * PHYSICS.ceilingRestitution;
      onBoundsContact();
    }
    // Il pavimento è un vero piano di collisione: il punteggio sale solo con i colpi del cerchio.
    if (ball.y > height - ball.r) {
      ball.y = height - ball.r;
      ball.vy = -Math.abs(ball.vy) * PHYSICS.floorRestitution;
      ball.vx *= PHYSICS.floorFriction;
      onBoundsContact();
    }
  }

  /** Controlla se la palla è ferma a terra abbastanza a lungo da diventare intangibile. */
  function updateRestState(frameDt) {
    const onFloor = ball.y >= height - ball.r - REST.floorTolerance;
    const isSlow = Math.hypot(ball.vx, ball.vy) < REST.maxSpeed;

    restTimer = onFloor && isSlow ? restTimer + frameDt : 0;

    if (restTimer >= REST.timeToSleep) {
      isDormant = true;
      ball.y = height - ball.r;
      ball.vx = 0;
      ball.vy = 0;
    }
  }

  /** Riattiva la palla facendole fare un salto verso l'alto. */
  function wakeUp() {
    isDormant = false;
    restTimer = 0;
    ball.vx = (Math.random() * 2 - 1) * REST.wakeJumpSpread;
    ball.vy = -REST.wakeJumpSpeed;
  }

  /** Avanza la simulazione di un frame, suddividendolo in sotto-passi. */
  function simulate(frameDt) {
    const substeps = Math.max(1, Math.ceil(frameDt / PHYSICS.maxSubstepDt));
    const dt = frameDt / substeps;

    for (let i = 0; i < substeps; i++) {
      ball.vy += PHYSICS.gravity * dt;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      ball.vx *= Math.pow(PHYSICS.airDrag, dt * 60);

      collideWithBounds();
      collideWithPaddle();
    }
  }

  // ==========================================================
  // Interfaccia animata
  // ==========================================================

  /** Molla smorzata: porta il valore a 0 oscillando (effetto "gonfia e rimbalza"). */
  function stepSpring(spring, dt) {
    const acceleration =
      -FEEL.springStiffness * spring.value - FEEL.springDamping * spring.velocity;
    spring.velocity += acceleration * dt;
    spring.value = clamp(spring.value + spring.velocity * dt, -0.6, 1);
  }

  function applyScale(element, spring) {
    element.style.transform = `scale(${1 + spring.value})`;
  }

  function updateHud(frameDt) {
    // Il numero mostrato rincorre il punteggio reale (conteggio fluido).
    const diff = score - displayedScore;
    displayedScore =
      Math.abs(diff) < 0.5
        ? score
        : displayedScore + diff * (1 - Math.exp(-FEEL.countUpRate * frameDt));

    const text = String(Math.round(displayedScore));
    if (text !== shownScoreText) {
      shownScoreText = text;
      scoreEl.textContent = text;
    }

    stepSpring(scorePop, frameDt);
    stepSpring(multiplierPop, frameDt);
    applyScale(scoreEl, scorePop);
    applyScale(multiplierEl, multiplierPop);
    stepSpring(airBonusPop, frameDt);
    applyScale(airBonusEl, airBonusPop);

    // "+N" fluttuanti
    for (const item of floatingTexts) item.age += frameDt;
    floatingTexts = floatingTexts.filter((item) => item.age < FEEL.floatingTextLife);

    // Onde dei trick
    for (const ring of trickRings) ring.age += frameDt;
    trickRings = trickRings.filter((ring) => ring.age < FEEL.trickRingLife);
  }

  // ==========================================================
  // Rendering
  // ==========================================================
  function drawCircle(x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  }

  function drawFloatingTexts() {
    ctx.textAlign = "center";
    ctx.lineJoin = "round";

    for (const item of floatingTexts) {
      const progress = item.age / FEEL.floatingTextLife;
      const rise = FEEL.floatingTextRise * (1 - Math.pow(1 - progress, 3));
      const popIn = 1 + 0.5 * Math.max(0, 1 - progress * 6); // si ingrandisce all'inizio

      ctx.globalAlpha = 1 - progress * progress;
      ctx.font = `800 ${item.size * popIn}px system-ui, sans-serif`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#fff";
      ctx.strokeText(item.text, item.x, item.y - rise);
      ctx.fillStyle = item.color;
      ctx.fillText(item.text, item.x, item.y - rise);
    }
    ctx.globalAlpha = 1;
  }

  /** Arco di progresso del giro attorno alla palla. */
  function drawTrickProgress() {
    if (trick.angle === null || Math.abs(trick.progress) < TRICK.minArcToShow) return;

    const fraction = Math.min(1, Math.abs(trick.progress) / TRICK_TARGET_ANGLE);
    ctx.beginPath();
    ctx.arc(
      ball.x,
      ball.y,
      ball.r + 12,
      trick.angle - trick.progress, // inizio dell'arco
      trick.angle,                  // posizione attuale del cursore
      trick.progress < 0            // senso antiorario se si gira al contrario
    );
    ctx.globalAlpha = 0.35 + 0.65 * fraction;
    ctx.strokeStyle = TRICK.color;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.globalAlpha = 1;
  }

  /** Onda che si espande dalla palla quando il giro riesce. */
  function drawTrickRings() {
    for (const ring of trickRings) {
      const progress = ring.age / FEEL.trickRingLife;
      const eased = 1 - Math.pow(1 - progress, 3);

      drawCircle(ring.x, ring.y, ball.r + 6 + FEEL.trickRingGrow * eased);
      ctx.globalAlpha = 1 - progress;
      ctx.strokeStyle = TRICK.color;
      ctx.lineWidth = 6 * (1 - progress) + 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawWakeHint() {
    ctx.fillStyle = "#666";
    ctx.font = "13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Clic sinistro per rilanciare la palla", ball.x, ball.y - ball.r - 14);
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    // Cerchio di contatto (tratteggiato).
    drawCircle(paddle.x, paddle.y, paddle.r);
    ctx.strokeStyle = "#c9c9c9";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Centro del cerchio.
    drawCircle(paddle.x, paddle.y, 3);
    ctx.fillStyle = "#999";
    ctx.fill();

    drawTrickProgress();
    drawTrickRings();

    // Palla (sbiadita se dormiente). Il bordo bianco la rende leggibile sopra il punteggio.
    ctx.globalAlpha = isDormant ? REST.dormantAlpha : 1;
    drawCircle(ball.x, ball.y, ball.r);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.fillStyle = "#222";
    ctx.fill();
    ctx.globalAlpha = 1;

    if (isDormant) drawWakeHint();
    drawFloatingTexts();
  }

  // ==========================================================
  // Ciclo principale
  // ==========================================================
  function frame(timestamp) {
    if (!lastTimestamp) lastTimestamp = timestamp;
    const frameDt = Math.min(
      PHYSICS.maxFrameDt,
      (timestamp - lastTimestamp) / 1000 || 0.016
    );
    lastTimestamp = timestamp;

    updatePaddleVelocity(frameDt);
    contactCooldown = Math.max(0, contactCooldown - frameDt);
    scoreCooldown = Math.max(0, scoreCooldown - frameDt);

    if (isDormant) {
      // Intangibile: nessuna fisica né collisioni, resta appoggiata al pavimento.
      ball.y = height - ball.r;
      resetTrick();
    } else {
      updateAirBonus(frameDt);
      simulate(frameDt);
      updateRestState(frameDt);
      updateTrick(frameDt);
    }

    updateHud(frameDt);
    draw();

    requestAnimationFrame(frame);
  }

  // ==========================================================
  // Avvio
  // ==========================================================
  canvas.addEventListener("pointermove", setPointer);
  canvas.addEventListener("pointerdown", onPointerDown);
  resetButton.addEventListener("click", reset);
  window.addEventListener("resize", resize);

  resize();
  reset();
  requestAnimationFrame(frame);
})();
