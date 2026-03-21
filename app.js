(() => {
  const snapshot = window.DEPOT_APP_SNAPSHOT;

  if (!snapshot || !snapshot.portfolio || !snapshot.rules || !snapshot.meta) {
    document.body.innerHTML = "<main style='padding:24px;color:#fff;font-family:sans-serif'>Fehlende Daten. Bitte zuerst ./generate-app-data.ps1 ausfuehren.</main>";
    return;
  }

  const portfolio = snapshot.portfolio;
  const rules = snapshot.rules;
  const meta = snapshot.meta;
  const positions = (portfolio.positions || []).map((position) => ({
    ...position,
    bucket: position.strategy_bucket || position.bucket || "Swing",
    theme_tags: Array.isArray(position.theme_tags) ? position.theme_tags : [],
  }));

  const state = {
    tab: "overview",
    filter: "Alle",
    query: "",
  };

  const totalValue = Number(portfolio.cash?.amount || 0) + positions.reduce((sum, item) => sum + Number(item.market_value || 0), 0);
  const cashAmount = Number(portfolio.cash?.amount || 0);
  const cashQuote = percent(cashAmount, totalValue);
  const analysis = buildAnalysis();

  renderChrome();
  renderOverview();
  renderPositions();
  renderRules();
  renderAssistant();
  bindEvents();
  maybeRegisterServiceWorker();

  function buildAnalysis() {
    const reserveValue = positions
      .filter((item) => item.bucket === "Reserve")
      .reduce((sum, item) => sum + Number(item.market_value || 0), 0);

    const combinedLiquidityQuote = percent(cashAmount + reserveValue, totalValue);
    const clusterWeights = aggregateBy("risk_cluster");
    const tagWeights = aggregateTags();

    const computedPositions = positions
      .map((position) => {
        const weightPct = percent(position.market_value, totalValue);
        const breaches = getBreaches(position, weightPct);
        const applicableLimit = getTightestLimit(position);
        const targetWeight = applicableLimit ? applicableLimit.limit : null;
        const sellAmount = targetWeight !== null && weightPct > targetWeight
          ? roundMoney(Number(position.market_value) - ((targetWeight / 100) * totalValue))
          : 0;

        return {
          ...position,
          weightPct,
          breaches,
          tone: breaches.length ? "danger" : weightPct >= 5.5 ? "warn" : "good",
          action: breaches.length ? "TEILVERKAUF" : weightPct < 2 ? "BEOBACHTEN" : "HALTEN",
          targetWeight,
          sellAmount,
        };
      })
      .sort((left, right) => right.weightPct - left.weightPct);

    const themeLimit = Number(rules.portfolio_rules?.max_theme_cluster_percent || 0);
    const clusterAlerts = clusterWeights
      .filter((item) => item.weightPct >= themeLimit * 0.75)
      .sort((left, right) => right.weightPct - left.weightPct);

    const hardBreaches = computedPositions.filter((item) => item.breaches.length);
    const healthScore = computeHealthScore(hardBreaches.length, combinedLiquidityQuote, cashQuote, clusterWeights);

    return {
      totalValue,
      cashAmount,
      cashQuote,
      reserveValue,
      combinedLiquidityQuote,
      clusterWeights,
      tagWeights,
      positions: computedPositions,
      hardBreaches,
      clusterAlerts,
      healthScore,
    };
  }

  function aggregateBy(key) {
    const buckets = new Map();

    positions.forEach((position) => {
      const bucketKey = position[key] || "Nicht klassifiziert";
      const current = buckets.get(bucketKey) || {
        name: bucketKey,
        value: 0,
        labels: [],
      };

      current.value += Number(position.market_value || 0);
      current.labels.push(`${position.name} (${position.symbol})`);
      buckets.set(bucketKey, current);
    });

    return [...buckets.values()]
      .map((item) => ({
        ...item,
        weightPct: percent(item.value, totalValue),
      }))
      .sort((left, right) => right.weightPct - left.weightPct);
  }

  function aggregateTags() {
    const buckets = new Map();

    positions.forEach((position) => {
      position.theme_tags.forEach((tag) => {
        const current = buckets.get(tag) || {
          name: tag,
          value: 0,
          labels: [],
        };
        current.value += Number(position.market_value || 0);
        current.labels.push(`${position.name} (${position.symbol})`);
        buckets.set(tag, current);
      });
    });

    return [...buckets.values()]
      .map((item) => ({
        ...item,
        weightPct: percent(item.value, totalValue),
      }))
      .sort((left, right) => right.weightPct - left.weightPct);
  }

  function getBreaches(position, weightPct) {
    const issues = [];
    const portfolioRules = rules.portfolio_rules || {};
    const swingRules = rules.swing_rules || {};

    if (isBroadMarketEtf(position) && weightPct > Number(portfolioRules.max_broad_market_etf_percent || 0)) {
      issues.push(`Broad ETF ueber ${portfolioRules.max_broad_market_etf_percent}%`);
    }

    if (position.bucket === "Reserve" && weightPct > Number(portfolioRules.max_reserve_position_percent || 0)) {
      issues.push(`Reserve ueber ${portfolioRules.max_reserve_position_percent}%`);
    }

    if (isThematicEtf(position) && weightPct > Number(portfolioRules.max_thematic_etf_percent || 0)) {
      issues.push(`Thematischer ETF ueber ${portfolioRules.max_thematic_etf_percent}%`);
    }

    if (isStock(position) && weightPct > Number(portfolioRules.max_single_stock_percent || 0)) {
      issues.push(`Einzelaktie ueber ${portfolioRules.max_single_stock_percent}%`);
    }

    if (isHighRiskStock(position) && weightPct > Number(portfolioRules.max_high_risk_stock_percent || 0)) {
      issues.push(`High-Risk-Aktie ueber ${portfolioRules.max_high_risk_stock_percent}%`);
    }

    if (position.bucket === "Swing" && weightPct > Number(swingRules.max_position_percent || 0)) {
      issues.push(`Swing ueber ${swingRules.max_position_percent}%`);
    }

    return issues;
  }

  function getTightestLimit(position) {
    const portfolioRules = rules.portfolio_rules || {};
    const swingRules = rules.swing_rules || {};
    const candidates = [];

    if (isBroadMarketEtf(position)) {
      candidates.push({ label: "Broad ETF", limit: Number(portfolioRules.max_broad_market_etf_percent || 0) });
    }
    if (position.bucket === "Reserve") {
      candidates.push({ label: "Reserve", limit: Number(portfolioRules.max_reserve_position_percent || 0) });
    }
    if (isThematicEtf(position)) {
      candidates.push({ label: "Thematischer ETF", limit: Number(portfolioRules.max_thematic_etf_percent || 0) });
    }
    if (isStock(position)) {
      candidates.push({ label: "Einzelaktie", limit: Number(portfolioRules.max_single_stock_percent || 0) });
    }
    if (isHighRiskStock(position)) {
      candidates.push({ label: "High Risk", limit: Number(portfolioRules.max_high_risk_stock_percent || 0) });
    }
    if (position.bucket === "Swing") {
      candidates.push({ label: "Swing", limit: Number(swingRules.max_position_percent || 0) });
    }

    const realCandidates = candidates.filter((item) => item.limit > 0);
    if (!realCandidates.length) {
      return null;
    }

    return realCandidates.sort((left, right) => left.limit - right.limit)[0];
  }

  function computeHealthScore(breachCount, liquidityQuote, currentCashQuote, clusterWeights) {
    let score = 100;
    score -= breachCount * 11;

    const minCash = Number(rules.portfolio_rules?.min_cash_quote_percent || 0);
    const targetLiquidity = parseRange(rules.portfolio_rules?.target_liquidity_buffer_percent);
    const themeClusterLimit = Number(rules.portfolio_rules?.max_theme_cluster_percent || 999);
    const topCluster = clusterWeights[0];

    if (currentCashQuote < minCash) {
      score -= 12;
    }

    if (liquidityQuote < targetLiquidity.min || liquidityQuote > targetLiquidity.max + 4) {
      score -= 7;
    }

    if (topCluster && topCluster.weightPct > themeClusterLimit) {
      score -= 8;
    }

    return Math.max(36, Math.min(98, Math.round(score)));
  }

  function renderChrome() {
    setText("totalValue", formatEuro(analysis.totalValue));
    setText("balanceSubline", `Cash ${formatEuro(analysis.cashAmount)} | ${formatPercent(analysis.cashQuote)} Cashquote | ${formatDate(portfolio.analysis_date)}`);
    setText("snapshotDateChip", `Snapshot ${formatDate(portfolio.analysis_date)}`);
    setText("healthScore", analysis.healthScore);
    setText("healthSummary", healthSummaryText());

    const ring = document.querySelector(".health-ring");
    const degrees = Math.round((analysis.healthScore / 100) * 360);
    ring.style.background = `radial-gradient(circle at center, rgba(7, 17, 29, 0.95) 52%, transparent 53%), conic-gradient(#7ef0cf ${degrees}deg, rgba(255,255,255,0.14) ${degrees}deg)`;

    const heroSignals = document.getElementById("heroSignals");
    heroSignals.innerHTML = [
      renderSignalItem(
        analysis.hardBreaches.length ? `${analysis.hardBreaches.length} harte Regelverstosse` : "Keine harten Regelverstosse",
        analysis.hardBreaches.length ? "Strikter Blick auf uebergrosse Swing- oder Themenpositionen." : "Leitplanken aktuell unter Kontrolle."
      ),
      renderSignalItem(
        `${formatPercent(analysis.combinedLiquidityQuote)} Liquiditaetspuffer`,
        corridorStatusText(analysis.combinedLiquidityQuote, rules.portfolio_rules?.target_liquidity_buffer_percent)
      ),
      renderSignalItem(
        `${analysis.clusterWeights[0]?.name || "Cluster"} bei ${formatPercent(analysis.clusterWeights[0]?.weightPct || 0)}`,
        "Die Seite zeigt dir Ballungen sofort als Fokusliste statt als verstreute Analysebausteine."
      ),
    ].join("");
  }

  function renderOverview() {
    const kpiGrid = document.getElementById("kpiGrid");
    const topWinner = [...analysis.positions].sort((a, b) => Number(b.profit_loss_percent) - Number(a.profit_loss_percent))[0];
    const topLoser = [...analysis.positions].sort((a, b) => Number(a.profit_loss_percent) - Number(b.profit_loss_percent))[0];

    kpiGrid.innerHTML = [
      renderMiniCard("Cashquote", formatPercent(analysis.cashQuote), toneForCorridor(analysis.cashQuote, `${rules.portfolio_rules?.target_cash_quote_percent}`)),
      renderMiniCard("Liquiditaet", formatPercent(analysis.combinedLiquidityQuote), toneForCorridor(analysis.combinedLiquidityQuote, `${rules.portfolio_rules?.target_liquidity_buffer_percent}`)),
      renderMiniCard("Top Gewinner", `${topWinner.symbol} ${signedPercent(topWinner.profit_loss_percent)}`, Number(topWinner.profit_loss_percent) >= 0 ? "good" : "danger"),
      renderMiniCard("Top Verlierer", `${topLoser.symbol} ${signedPercent(topLoser.profit_loss_percent)}`, Number(topLoser.profit_loss_percent) >= 0 ? "good" : "danger"),
    ].join("");

    const alerts = [
      ...analysis.hardBreaches.slice(0, 5).map((position) => ({
        title: `${position.symbol} auf ${formatPercent(position.weightPct)}`,
        detail: `${position.breaches[0]}. Grobe Entlastung: ${formatEuro(position.sellAmount)} bis Ziel ${formatPercent(position.targetWeight || 0)}.`,
        tone: "danger",
        action: position.action,
      })),
      ...analysis.clusterAlerts.slice(0, 2).map((cluster) => ({
        title: `${cluster.name} im Fokus`,
        detail: `${formatPercent(cluster.weightPct)} Clustergewicht. Noch nicht zwingend ueber Limit, aber nahe an der Komfortgrenze.`,
        tone: cluster.weightPct > Number(rules.portfolio_rules?.max_theme_cluster_percent || 0) ? "danger" : "warn",
        action: "BEOBACHTEN",
      })),
    ];

    document.getElementById("alertsList").innerHTML = alerts.length
      ? alerts.map(renderAlertCard).join("")
      : renderAlertCard({
          title: "Keine akuten Warnungen",
          detail: "Damit wuerde die Seite heute eher beruhigen als nervoes machen.",
          tone: "good",
          action: "HALTEN",
        });

    document.getElementById("clusterBars").innerHTML = analysis.clusterWeights
      .slice(0, 5)
      .map((cluster) => renderBarCard(cluster.name, cluster.weightPct, Number(rules.portfolio_rules?.max_theme_cluster_percent || 22)))
      .join("");

    const helperModes = [
      {
        title: "Push statt Prompt-Kette",
        copy: "Du siehst auf einen Blick, wenn ein Limit kippt, Cash zu knapp wird oder ein Snapshot auffaellig wirkt.",
      },
      {
        title: "Ein Blick statt 4 Dateien",
        copy: "CSV, Regeln, Risikocluster und Handlungsempfehlung laufen in einer einzigen mobilen Seite zusammen.",
      },
      {
        title: "Sofort klarer Wochenplan",
        copy: "Heute handeln, diese Woche beobachten, bewusst nichts tun: genau diese drei Ebenen werden fuer dich sichtbar.",
      },
      {
        title: "Auf dem Handy speichern",
        copy: "Im Browser oeffnen, zum Startbildschirm hinzufuegen, fertig. Mehr muss fuer deinen Alltag nicht passieren.",
      },
    ];

    document.getElementById("helperModes").innerHTML = helperModes.map(renderFeatureCard).join("");
  }

  function renderPositions() {
    const filters = ["Alle", "Verstoesse", "Core", "Swing", "Reserve"];
    const bucketFilters = document.getElementById("bucketFilters");
    bucketFilters.innerHTML = filters
      .map((filter) => `<button class="chip-button ${state.filter === filter ? "is-active" : ""}" data-filter="${filter}">${filter}</button>`)
      .join("");

    const query = state.query.trim().toLowerCase();
    const filtered = analysis.positions.filter((position) => {
      const matchesFilter =
        state.filter === "Alle"
        || (state.filter === "Verstoesse" && position.breaches.length > 0)
        || position.bucket === state.filter;

      const haystack = [
        position.name,
        position.symbol,
        position.risk_cluster,
        ...(position.theme_tags || []),
      ].join(" ").toLowerCase();

      return matchesFilter && (!query || haystack.includes(query));
    });

    document.getElementById("positionsList").innerHTML = filtered
      .map(renderPositionCard)
      .join("");
  }

  function renderRules() {
    const hardLimitEntries = [
      ["Broad-Market-ETF", `${rules.portfolio_rules?.max_broad_market_etf_percent}%`],
      ["Thematischer ETF", `${rules.portfolio_rules?.max_thematic_etf_percent}%`],
      ["Einzelaktie", `${rules.portfolio_rules?.max_single_stock_percent}%`],
      ["High-Risk-Aktie", `${rules.portfolio_rules?.max_high_risk_stock_percent}%`],
      ["Swing Maximum", `${rules.swing_rules?.max_position_percent}%`],
      ["Themen-Cluster", `${rules.portfolio_rules?.max_theme_cluster_percent}%`],
    ];

    document.getElementById("hardLimits").innerHTML = hardLimitEntries
      .map(([label, value]) => renderMiniRuleCard(label, value))
      .join("");

    const corridorEntries = [
      ["Cashziel", `${rules.portfolio_rules?.target_cash_quote_percent}%`],
      ["Mindest-Cash", `${rules.portfolio_rules?.min_cash_quote_percent}%`],
      ["Liquiditaetspuffer", `${rules.portfolio_rules?.target_liquidity_buffer_percent}%`],
      ["Core breit", `${rules.core_rules?.broad_core_target_range_percent}%`],
      ["Reserve", `${rules.reserve_rules?.target_range_percent}%`],
      ["Swing", `${rules.swing_rules?.target_range_percent}%`],
    ];

    document.getElementById("corridorList").innerHTML = corridorEntries
      .map(([label, value]) => renderMiniRuleCard(label, value))
      .join("");

    const reasons = [
      {
        title: "Automation bleibt das Rueckgrat",
        text: "Die Seite ersetzt deine bestehende Logik nicht. Sie nimmt dir nur die Reibung bei Sichtbarkeit, Einordnung und mobilen Entscheidungen ab.",
      },
      {
        title: "Regeln werden visuell statt textlastig",
        text: "Gerade bei Swing-Maxima, Cashquote und Clusterballungen ist eine visuelle Ampel deutlich staerker als ein langer Bericht.",
      },
      {
        title: "Kein App-Store noetig",
        text: "Du brauchst weder iPhone-App noch Play-Store-App. Ein sauberer mobiler Web-Aufruf reicht fuer deinen Alltag vollkommen aus.",
      },
    ];

    document.getElementById("logicReasons").innerHTML = reasons
      .map((item) => `<article class="reason-card"><strong>${item.title}</strong><p class="muted">${item.text}</p></article>`)
      .join("");
  }

  function renderAssistant() {
    const focusPositions = analysis.hardBreaches.slice(0, 3);
    const assistantBlocks = [
      {
        title: "Diese Woche priorisieren",
        items: focusPositions.length
          ? focusPositions.map((position) => `${position.symbol}: ${position.breaches.join(", ")}. Entlastung grob ${formatEuro(position.sellAmount)}.`)
          : ["Keine Pflichtaktion. Schwerpunkt liegt auf Beobachtung und Disziplin."],
      },
      {
        title: "Bewusst nicht tun",
        items: [
          "Nicht wegen einzelner roter P/L-Zahlen hektisch umschichten, wenn keine Regel verletzt ist.",
          "Keinen Nachkauf aus dem Bauch heraus, falls Cash unter die Mindestquote ruecken wuerde.",
          "Themenballungen nicht uebersehen, nur weil die Einzeltitel einzeln noch akzeptabel wirken.",
        ],
      },
      {
        title: "Warum diese einfache Loesung stark ist",
        items: [
          "Aus Regeln und Snapshots entsteht ein knapper, verstaendlicher Wochenbrief statt Dateichaos.",
          "Wenn du spaeter mehr willst, kann dieselbe Seite immer noch mit KI, Verlauf oder Sprache erweitert werden.",
        ],
      },
    ];

    document.getElementById("assistantBriefing").innerHTML = assistantBlocks
      .map((block) => `
        <section class="assistant-block">
          <strong>${block.title}</strong>
          <ul>${block.items.map((item) => `<li>${item}</li>`).join("")}</ul>
        </section>
      `)
      .join("");

    const roadmap = [
      {
        title: "Phase 1: Einfache Handy-Seite",
        text: "Mobile Startseite, Snapshot aktualisieren, auf dem Handy speichern und direkt oeffnen.",
      },
      {
        title: "Phase 2: Verlauf",
        text: "Spaeter kann ein Vergleich zum letzten Snapshot dazu kommen, ohne dass die Seite komplizierter wird.",
      },
      {
        title: "Phase 3: Optional KI-Briefing",
        text: "Nur wenn du willst: kurze KI-Zusammenfassungen und Erklaerungen zu Veraenderungen.",
      },
      {
        title: "Phase 4: Optional Sprache",
        text: "Erst ganz spaet sinnvoll: Audio-Briefings oder Sprachfragen fuer unterwegs.",
      },
    ];

    document.getElementById("futureStack").innerHTML = roadmap
      .map((item) => `<article class="future-card"><strong>${item.title}</strong><p class="muted">${item.text}</p></article>`)
      .join("");
  }

  function bindEvents() {
    document.querySelectorAll(".tab-button").forEach((button) => {
      button.addEventListener("click", () => {
        state.tab = button.dataset.tab;
        document.querySelectorAll(".tab-button").forEach((item) => item.classList.toggle("is-active", item === button));
        document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === `tab-${state.tab}`));
      });
    });

    document.getElementById("positionSearch").addEventListener("input", (event) => {
      state.query = event.target.value;
      renderPositions();
    });

    document.getElementById("bucketFilters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) {
        return;
      }

      state.filter = button.dataset.filter;
      renderPositions();
    });

  }

  function maybeRegisterServiceWorker() {
    if ("serviceWorker" in navigator && window.location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  function healthSummaryText() {
    if (analysis.healthScore >= 85) {
      return "Stabil. Die Seite dient vor allem als Fruehwarnsystem.";
    }
    if (analysis.healthScore >= 70) {
      return "Solide, aber mit ein paar Positionen ueber Komfortbereich.";
    }
    return "Mehrere Positionen brauchen aktive Entlastung oder engere Beobachtung.";
  }

  function corridorStatusText(value, rawRange) {
    const range = parseRange(rawRange);
    if (value < range.min) {
      return `Unter Zielkorridor ${range.min}-${range.max}%.`;
    }
    if (value > range.max) {
      return `Ueber Zielkorridor ${range.min}-${range.max}%.`;
    }
    return `Innerhalb Zielkorridor ${range.min}-${range.max}%.`;
  }

  function toneForCorridor(value, rawRange) {
    const range = parseRange(rawRange);
    if (value < range.min || value > range.max) {
      return "warn";
    }
    return "good";
  }

  function parseRange(rawRange) {
    const text = `${rawRange || ""}`;
    const numbers = text.split("-").map((part) => Number(part.trim())).filter((part) => !Number.isNaN(part));
    if (numbers.length === 2) {
      return { min: numbers[0], max: numbers[1] };
    }

    const single = Number(text);
    if (!Number.isNaN(single)) {
      return { min: single, max: single };
    }

    return { min: 0, max: 0 };
  }

  function renderSignalItem(title, detail) {
    return `<li class="signal-item"><strong>${title}</strong><p class="muted">${detail}</p></li>`;
  }

  function renderMiniCard(label, value, tone) {
    return `
      <article class="mini-card">
        <p class="card-label">${label}</p>
        <div class="value tone-${tone}">${value}</div>
      </article>
    `;
  }

  function renderAlertCard(item) {
    return `
      <article class="alert-card">
        <div class="alert-topline">
          <strong>${item.title}</strong>
          <span class="pill pill-${item.tone}">${item.action}</span>
        </div>
        <p class="muted">${item.detail}</p>
      </article>
    `;
  }

  function renderBarCard(label, value, limit) {
    const ratio = Math.min((value / Math.max(limit, 1)) * 100, 100);
    const tone = value > limit ? "danger" : value > limit * 0.8 ? "warn" : "good";

    return `
      <article class="mini-card">
        <div class="bar-row">
          <strong>${label}</strong>
          <span class="pill pill-${tone}">${formatPercent(value)}</span>
        </div>
        <div class="bar ${tone}">
          <span style="width:${ratio}%"></span>
        </div>
      </article>
    `;
  }

  function renderFeatureCard(item) {
    return `<article class="feature-card"><strong>${item.title}</strong><p class="muted">${item.copy}</p></article>`;
  }

  function renderMiniRuleCard(label, value) {
    return `<article class="mini-card"><strong>${label}</strong><p class="muted">${value}</p></article>`;
  }

  function renderPositionCard(position) {
    const tone = position.breaches.length ? "danger" : Number(position.profit_loss_percent) < 0 ? "warn" : "good";
    const barRatio = Math.min(position.weightPct / 18 * 100, 100);
    const chips = [
      position.bucket,
      position.asset_type,
      position.risk_cluster || "ohne Cluster",
    ];

    return `
      <article class="position-card">
        <div class="position-head">
          <div>
            <strong>${position.name}</strong>
            <p class="muted">${position.symbol}</p>
          </div>
          <span class="pill pill-${tone}">${position.action}</span>
        </div>

        <div class="position-meta">
          ${chips.map((chip) => `<span class="meta-chip">${chip}</span>`).join("")}
        </div>

        <div class="bar ${tone}">
          <span style="width:${barRatio}%"></span>
        </div>

        <div class="stat-grid">
          ${renderMiniCard("Gewicht", formatPercent(position.weightPct), tone)}
          ${renderMiniCard("P/L", `${signedPercent(position.profit_loss_percent)} | ${signedEuro(position.profit_loss_amount)}`, Number(position.profit_loss_percent) >= 0 ? "good" : "warn")}
          ${renderMiniCard("Marktwert", formatEuro(position.market_value), "good")}
          ${renderMiniCard("Zielgewicht", position.targetWeight !== null ? formatPercent(position.targetWeight) : "n/a", position.breaches.length ? "danger" : "good")}
        </div>

        <div class="position-tags">
          ${(position.theme_tags || []).map((tag) => `<span class="meta-chip">${tag}</span>`).join("")}
        </div>

        <p class="muted">
          ${position.breaches.length
            ? `${position.breaches.join(" | ")}. Grobe Entlastung: ${formatEuro(position.sellAmount)}.`
            : "Keine harte Regelverletzung. Eher Beobachtung als Aktion."}
        </p>
      </article>
    `;
  }

  function isEtf(position) {
    return `${position.asset_type || ""}`.toUpperCase() === "ETF";
  }

  function isStock(position) {
    return !isEtf(position);
  }

  function isBroadMarketEtf(position) {
    const tags = new Set(position.theme_tags || []);
    return isEtf(position) && (position.bucket === "Core" || tags.has("Broad Market"));
  }

  function isThematicEtf(position) {
    return isEtf(position) && position.bucket !== "Reserve" && !isBroadMarketEtf(position);
  }

  function isHighRiskStock(position) {
    if (!isStock(position)) {
      return false;
    }

    const tags = new Set(position.theme_tags || []);
    const riskyTags = ["AI", "China", "EV", "Cloud", "Semiconductors"];
    return riskyTags.some((tag) => tags.has(tag)) || ["AI", "China EV", "China Tech"].includes(position.risk_cluster);
  }

  function percent(value, total) {
    if (!total) {
      return 0;
    }

    return (Number(value || 0) / Number(total)) * 100;
  }

  function roundMoney(value) {
    return Math.max(0, Math.round(Number(value || 0)));
  }

  function formatEuro(value) {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    }).format(Number(value || 0));
  }

  function signedEuro(value) {
    const number = Number(value || 0);
    return `${number > 0 ? "+" : ""}${new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    }).format(number)}`;
  }

  function formatPercent(value) {
    return `${Number(value || 0).toLocaleString("de-DE", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}%`;
  }

  function signedPercent(value) {
    const number = Number(value || 0);
    const formatted = number.toLocaleString("de-DE", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    return `${number > 0 ? "+" : ""}${formatted}%`;
  }

  function formatDate(value) {
    if (!value) {
      return "ohne Datum";
    }

    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) {
      return value;
    }

    return new Intl.DateTimeFormat("de-DE", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(date);
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = value;
    }
  }
})();
