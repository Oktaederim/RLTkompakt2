document.addEventListener('DOMContentLoaded', () => {
    const inputs = document.querySelectorAll('input[type="number"], input[type="radio"]');
    inputs.forEach(input => input.addEventListener('input', calculate));
    document.getElementById('resetBtn').addEventListener('click', resetAll);
    document.querySelectorAll('input[name="betriebsmodus"], input[name="heizkonzept"]').forEach(radio => radio.addEventListener('change', toggleUI));
    toggleUI();
    calculate();
});

const defaultValues = {
    tempAussen: 20.0, rhAussen: 50.0,
    tempZuluft: 20.0, rhZuluft: 60.0,
    volumenstrom: 5000, druck: 1013.25,
    tempVEZiel: 5.0,
    betriebsmodus: 'entfeuchten',
    heizkonzept: 'standard'
};

function resetAll() {
    for (const key in defaultValues) {
        const el = document.getElementById(key);
        if (el) {
            el.value = defaultValues[key];
        } else {
            document.querySelector(`input[name="${key}"][value="${defaultValues[key]}"]`).checked = true;
        }
    }
    toggleUI();
    calculate();
}

function toggleUI() {
    const betriebsmodus = document.querySelector('input[name="betriebsmodus"]:checked').value;
    const heizkonzept = document.querySelector('input[name="heizkonzept"]:checked').value;
    
    document.getElementById('sollFeuchteWrapper').style.display = (betriebsmodus === 'entfeuchten') ? 'block' : 'none';
    document.getElementById('kuehlwasserWrapper').style.display = (betriebsmodus === 'heizen') ? 'none' : 'block';
    
    const veZielTempWrapper = document.getElementById('veZielTempWrapper');
    veZielTempWrapper.style.display = (heizkonzept === 'standard') ? 'block' : 'none';
    veZielTempWrapper.querySelector('label').textContent = (heizkonzept === 'standard') ? 'VE Frostschutz-Zieltemp. (°C)' : 'VE Ziel-Temperatur (°C)';
}

// --- Psychrometrische Hilfsfunktionen (unverändert) ---
const getSVP = (T) => 6.112 * Math.exp((17.62 * T) / (243.12 + T));
const getAbsFeuchte = (T, rh, p) => 622 * (rh / 100 * getSVP(T)) / (p - (rh / 100 * getSVP(T)));
const getRelFeuchte = (T, x, p) => {
    const svp = getSVP(T);
    if (svp <= 0) return 0;
    const rh = (x * p) / (svp * (622 + x)) * 100;
    return Math.min(100, Math.max(0, rh));
};
const getEnthalpie = (T, x) => 1.006 * T + (x / 1000) * (2501 + 1.86 * T);
const getTaupunkt = (T, rh) => {
    if (rh <= 0) return -273.15;
    const a = 17.62, b = 243.12;
    const alpha = Math.log(rh / 100) + (a * T) / (b + T);
    return (b * alpha) / (a - alpha);
};
const createZustand = (T, rh, x_val, p) => {
    const zustand = { T, p };
    if (x_val !== null) {
        zustand.x = x_val;
        zustand.rh = getRelFeuchte(T, x_val, p);
    } else {
        zustand.rh = rh;
        zustand.x = getAbsFeuchte(T, rh, p);
    }
    zustand.h = getEnthalpie(zustand.T, zustand.x);
    zustand.td = getTaupunkt(zustand.T, zustand.rh);
    return zustand;
};

// ###############################################################
// ################ NEUE BERECHNUNGSLOGIK ########################
// ###############################################################
function calculate() {
    const inputs = {
        betriebsmodus: document.querySelector('input[name="betriebsmodus"]:checked').value,
        heizkonzept: document.querySelector('input[name="heizkonzept"]:checked').value,
        tAussen: parseFloat(document.getElementById('tempAussen').value),
        rhAussen: parseFloat(document.getElementById('rhAussen').value),
        tZuluft: parseFloat(document.getElementById('tempZuluft').value),
        rhZuluft: parseFloat(document.getElementById('rhZuluft').value),
        volumenstrom: parseFloat(document.getElementById('volumenstrom').value),
        druck: parseFloat(document.getElementById('druck').value),
        tVEZiel: parseFloat(document.getElementById('tempVEZiel').value),
        tHeizV: parseFloat(document.getElementById('tempHeizVorlauf').value),
        tHeizR: parseFloat(document.getElementById('tempHeizRuecklauf').value),
        tKuehlV: parseFloat(document.getElementById('tempKuehlVorlauf').value),
        tKuehlR: parseFloat(document.getElementById('tempKuehlRuecklauf').value)
    };
    
    const massenstrom = (inputs.volumenstrom * 1.2) / 3600;
    let p_ve = 0, p_k = 0, p_ne = 0, kondensat = 0, t_kuehl_ziel = 0;

    // 1. Alle relevanten Zustände definieren
    const zustand0 = createZustand(inputs.tAussen, inputs.rhAussen, null, inputs.druck);
    const x_soll_zuluft = getAbsFeuchte(inputs.tZuluft, inputs.rhZuluft, inputs.druck);
    
    // 2. Prüfen, ob Entfeuchtung (also Kühlen) der primäre Prozess ist
    const entfeuchtungNotwendig = (inputs.betriebsmodus === 'entfeuchten' && zustand0.x > x_soll_zuluft + 0.1);

    // Initialisiere alle Zustände mit dem vorhergehenden Zustand
    let zustand1 = { ...zustand0 };
    let zustand2 = { ...zustand1 };
    let zustand3 = { ...zustand2 };

    // -------- 3. Komponenten-Logik (sequenziell) --------

    // ### VORERHITZER (VE) ###
    let veAktiv = false;
    if (inputs.heizkonzept === 'standard') {
        // Im Standard-Modus: VE nur für Frostschutz
        if (zustand0.T < inputs.tVEZiel - 0.01) veAktiv = true;
    } else { // ve_hauptleistung
        // Im VE-Hauptleistungs-Modus: VE heizt, ABER NUR wenn keine Entfeuchtung nötig ist
        if (!entfeuchtungNotwendig && inputs.tZuluft > zustand0.T + 0.01) veAktiv = true;
    }
    
    if (veAktiv) {
        const zielTempVE = (inputs.heizkonzept === 'standard') ? inputs.tVEZiel : inputs.tZuluft;
        zustand1 = createZustand(zielTempVE, null, zustand0.x, inputs.druck);
        p_ve = massenstrom * (zustand1.h - zustand0.h);
    }
    
    // Zustand nach VE an Kühler weitergeben
    zustand2 = { ...zustand1 };

    // ### KÜHLER (K) ###
    const kuehlungNotwendig = entfeuchtungNotwendig || (inputs.betriebsmodus === 'kuehlen_sensibel' && zustand1.T > inputs.tZuluft + 0.01);

    if (kuehlungNotwendig) {
        t_kuehl_ziel = entfeuchtungNotwendig ? getTaupunkt(inputs.tZuluft, inputs.rhZuluft) : inputs.tZuluft;
        const x_ziel_kuehler = entfeuchtungNotwendig ? x_soll_zuluft : zustand1.x;
        
        if (zustand1.T > t_kuehl_ziel - 0.01) {
            zustand2 = createZustand(t_kuehl_ziel, 100, x_ziel_kuehler, inputs.druck);
            p_k = massenstrom * (zustand2.h - zustand1.h);
            kondensat = massenstrom * (Math.max(0, zustand1.x - zustand2.x)) * 3.6;
        }
    }

    // Zustand nach Kühler an Nacherhitzer weitergeben
    zustand3 = { ...zustand2 };
    
    // ### NACHERHITZER (NE) ###
    if (zustand2.T < inputs.tZuluft - 0.01) {
        zustand3 = createZustand(inputs.tZuluft, null, zustand2.x, inputs.druck);
        p_ne = massenstrom * (zustand3.h - zustand2.h);
    }
    
    // -------- 4. Finale Aufbereitung --------
    const allStates = [zustand0, zustand1, zustand2, zustand3];
    const finalPowers = { p_ve, p_k, p_ne, kondensat, t_kuehl_ziel };

    const cp_wasser = 4.187, rho_wasser = 1000;
    finalPowers.wv_ve = (p_ve > 0 && inputs.tHeizV > inputs.tHeizR) ? (p_ve * 3600) / (cp_wasser * (inputs.tHeizV - inputs.tHeizR) * rho_wasser) : 0;
    finalPowers.wv_ne = (p_ne > 0 && inputs.tHeizV > inputs.tHeizR) ? (p_ne * 3600) / (cp_wasser * (inputs.tHeizV - inputs.tHeizR) * rho_wasser) : 0;
    finalPowers.wv_k = (p_k < 0 && inputs.tKuehlR > inputs.tKuehlV) ? (Math.abs(p_k) * 3600) / (cp_wasser * (inputs.tKuehlR - inputs.tKuehlV) * rho_wasser) : 0;

    updateUI(allStates, finalPowers, inputs);
}


function updateUI(states, powers, inputs) {
    const f = (val, dec) => val.toFixed(dec);

    states.forEach((state, i) => {
        if(document.getElementById(`res-t-${i}`)){
            document.getElementById(`res-t-${i}`).textContent = f(state.T, 1);
            document.getElementById(`res-rh-${i}`).textContent = f(state.rh, 1);
            document.getElementById(`res-x-${i}`).textContent = f(state.x, 2);
        }
    });
    const finalState = states[states.length - 1];
    document.getElementById('res-t-final').textContent = f(finalState.T, 1);
    document.getElementById('res-rh-final').textContent = f(finalState.rh, 1);
    document.getElementById('res-x-final').textContent = f(finalState.x, 2);

    document.getElementById('res-p-ve').textContent = f(powers.p_ve, 2);
    document.getElementById('res-p-k').textContent = f(Math.abs(powers.p_k), 2);
    document.getElementById('res-p-ne').textContent = f(powers.p_ne, 2);
    document.getElementById('res-kondensat').textContent = f(Math.max(0, powers.kondensat), 2);
    document.getElementById('res-wv-ve').textContent = f(powers.wv_ve, 2);
    document.getElementById('res-wv-k').textContent = f(powers.wv_k, 2);
    document.getElementById('res-wv-ne').textContent = f(powers.wv_ne, 2);

    const totalHeat = powers.p_ve + powers.p_ne;
    const totalCool = Math.abs(powers.p_k);
    document.getElementById('summary-power-heat').textContent = `${f(totalHeat, 2)} kW`;
    document.getElementById('summary-power-cool').textContent = `${f(totalCool, 2)} kW`;
    
    const paramMapping = { t: 'T', rh: 'rh', x: 'x', h: 'h', td: 'td' };
    Object.keys(paramMapping).forEach(paramKey => {
        const stateKey = paramMapping[paramKey];
        const unit = {'t':'°C', 'rh':'%', 'x':'g/kg', 'h':'kJ/kg', 'td':'°C'}[paramKey];
        const dec = (paramKey === 't' || paramKey === 'rh' || paramKey === 'td') ? 1 : 2;
        
        document.getElementById(`summary-${paramKey}-aussen`).textContent = `${f(states[0][stateKey], dec)} ${unit}`;
        document.getElementById(`summary-${paramKey}-zuluft`).textContent = `${f(finalState[stateKey], dec)} ${unit}`;
    });

    updateProcessVisuals(states, powers, inputs);
}

function updateProcessVisuals(states, powers, inputs) {
    const isHeating = powers.p_ve > 0.01 || powers.p_ne > 0.01;
    const isCooling = powers.p_k < -0.01;
    const isDehumidifying = powers.kondensat > 0.01;
    
    let processText = "Keine Luftbehandlung notwendig.";
    if (isHeating && !isCooling) processText = "Reiner Heizprozess.";
    if (!isHeating && isCooling && !isDehumidifying) processText = "Sensibler Kühlprozess.";
    if (isCooling && isDehumidifying && powers.p_ne <= 0.01) processText = "Reiner Entfeuchtungsprozess.";
    if (isCooling && isDehumidifying && powers.p_ne > 0.01) processText = "Kühlen mit Entfeuchtung und Nacherwärmung.";
    if (powers.p_ve > 0.01 && isCooling) processText = "Frostschutz mit anschließendem Kühlprozess.";
    
    let warningText = '';
    if (isCooling && isDehumidifying && powers.t_kuehl_ziel < inputs.tKuehlV) {
        warningText += `<br><strong>Achtung:</strong> Die Kühlwasser-Vorlauftemperatur (${inputs.tKuehlV}°C) ist zu hoch, um den benötigten Taupunkt von ${powers.t_kuehl_ziel.toFixed(1)}°C zu erreichen.`;
    }
    if (isHeating && (inputs.tHeizV - inputs.tZuluft < 10) && (inputs.tZuluft - inputs.tAussen > 15)) {
        warningText += `<br><strong>Hinweis:</strong> Die Heizwasser-Vorlauftemperatur (${inputs.tHeizV}°C) ist für den großen Temperaturhub eventuell zu niedrig.`;
    }

    const overview = document.createElement('div');
    overview.className = 'process-overview process-info';
    overview.innerHTML = processText + warningText;
    const container = document.getElementById('process-overview-container');
    container.innerHTML = '';
    container.appendChild(overview);
    
    document.getElementById('comp-ve').classList.toggle('inactive', powers.p_ve < 0.01);
    document.getElementById('comp-k').classList.toggle('inactive', powers.p_k > -0.01);
    document.getElementById('comp-ne').classList.toggle('inactive', powers.p_ne < 0.01);
    
    const setNodeColor = (nodeId, colorClass) => {
        const node = document.getElementById(nodeId);
        node.classList.remove('color-red', 'color-blue', 'color-green');
        if (colorClass) node.classList.add(colorClass);
    };
    
    const getColorFromTempChange = (temp, baseTemp) => {
        if (temp > baseTemp + 0.1) return 'color-red';
        if (temp < baseTemp - 0.1) return 'color-blue';
        return null;
    };

    setNodeColor('node-0', 'color-green');
    setNodeColor('node-1', getColorFromTempChange(states[1].T, states[0].T));
    setNodeColor('node-2', getColorFromTempChange(states[2].T, states[1].T));
    setNodeColor('node-3', getColorFromTempChange(states[3].T, states[2].T));
    setNodeColor('node-final', getColorFromTempChange(states[3].T, states[2].T));
}
