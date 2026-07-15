(function() {

let state = {
  power: { radio: false },
  playing: { radio: false },
  current: { radio: null },
  volume: { radio: 50 },
  eq: { 60: 0, 200: 0, 500: 0, 1000: 0, 5000: 0, 10000: 0 },
  audio: {
    ctx: null,
    audioEl: null,
    eqFilters: [],
    masterGain: null
  }
};

const EQ_FREQUENCIES = [60, 200, 500, 1000, 5000, 10000];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0],
  rock: [6, 4, 2, -2, 2, 5],
  pop: [3, 2, 1, 2, 4, 5],
  jazz: [4, 3, 2, 2, 3, 4]
};

function $(id) { return document.getElementById(id); }

function init() {
  loadEqSettings();
  renderStationList();
  bindEvents();
  updateVolumeUI();
  updateEqUI();
  
  toast('欢迎使用复古网络收音机！');
}

function renderStationList(filterText = '') {
  const list = $('stationList');
  const channels = getChannelsFor('radio');
  
  const filtered = filterText 
    ? channels.filter(ch => ch.name.toLowerCase().includes(filterText.toLowerCase()) || 
                          ch.description.toLowerCase().includes(filterText.toLowerCase()))
    : channels;
  
  list.innerHTML = filtered.map(ch => `
    <div class="station-item" data-id="${ch.id}" onclick="selectChannel('${ch.id}')">
      <span class="station-item-icon">🎵</span>
      <div class="station-item-info">
        <div class="station-item-name">${ch.name}</div>
        <div class="station-item-freq">${ch.frequency}</div>
        <div class="station-item-desc">${ch.description}</div>
      </div>
    </div>
  `).join('');
  
  if (state.current.radio) {
    const activeItem = list.querySelector(`[data-id="${state.current.radio}"]`);
    if (activeItem) activeItem.classList.add('active');
  }
}

function selectChannel(channelId) {
  if (!state.power.radio) {
    toast('请先打开电源', true);
    return;
  }
  
  const channels = getChannelsFor('radio');
  const ch = channels.find(c => c.id === channelId);
  if (!ch) return;
  
  state.current.radio = channelId;
  $('radioChannelName').textContent = ch.name;
  $('radioChannelFreq').textContent = ch.frequency;
  
  document.querySelectorAll('.station-item').forEach(el => el.classList.remove('active'));
  const activeItem = document.querySelector(`[data-id="${channelId}"]`);
  if (activeItem) activeItem.classList.add('active');
  
  playChannel(ch);
}

function playChannel(ch) {
  stopRadio();
  
  state.playing.radio = true;
  
  if (!state.audio.ctx) {
    initAudioGraph();
  }
  
  const audio = state.audio.audioEl || document.createElement('audio');
  audio.crossOrigin = 'anonymous';
  audio.loop = true;
  
  state.audio.audioEl = audio;
  
  const url = ch.url;
  if (url.toLowerCase().includes('.m3u8')) {
    if (window.Hls) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true
      });
      hls.loadSource(url);
      hls.attachMedia(audio);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        startPlayback();
      });
      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLS error:', data);
        if (data.fatal) {
          toast('播放失败，尝试直接播放', true);
          audio.src = url;
          startPlayback();
        }
      });
    } else {
      audio.src = url;
      startPlayback();
    }
  } else {
    audio.src = url;
    startPlayback();
  }
}

function startPlayback() {
  state.audio.audioEl.play().then(() => {
    connectAudioSource();
    startVisualizer();
  }).catch(err => {
    console.error('Playback failed:', err);
    toast('播放失败：' + err.message, true);
    state.playing.radio = false;
  });
}

function stopRadio() {
  state.playing.radio = false;
  if (state.audio.audioEl) {
    state.audio.audioEl.pause();
    state.audio.audioEl.src = '';
  }
  stopVisualizer();
}

function initAudioGraph() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    state.audio.ctx = ctx;
    
    state.audio.masterGain = ctx.createGain();
    state.audio.masterGain.gain.value = state.volume.radio / 100;
    state.audio.masterGain.connect(ctx.destination);
    
    EQ_FREQUENCIES.forEach((freq, i) => {
      const filter = ctx.createBiquadFilter();
      filter.type = i === 0 ? 'lowshelf' : (i === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking');
      filter.frequency.value = freq;
      filter.gain.value = state.eq[freq] || 0;
      filter.Q.value = 1.0;
      state.audio.eqFilters.push(filter);
    });
    
    let prevNode = state.audio.masterGain;
    for (let i = state.audio.eqFilters.length - 1; i >= 0; i--) {
      state.audio.eqFilters[i].connect(prevNode);
      prevNode = state.audio.eqFilters[i];
    }
    
  } catch (err) {
    console.warn('Audio context init failed:', err);
  }
}

function connectAudioSource() {
  if (!state.audio.ctx || !state.audio.audioEl || !state.audio.eqFilters.length) return;
  
  try {
    const source = state.audio.ctx.createMediaElementSource(state.audio.audioEl);
    source.connect(state.audio.eqFilters[0]);
  } catch (e) {
    console.warn('Connect source failed:', e);
  }
}

function togglePower(device) {
  state.power[device] = !state.power[device];
  
  const powerBtn = $('powerBtn');
  const powerLabel = $('powerLabel');
  
  if (state.power[device]) {
    powerBtn.classList.add('on');
    powerLabel.textContent = 'ON';
    $('radioChannelName').textContent = '— 选择电台 —';
    $('radioChannelFreq').textContent = 'READY';
    
    if (state.audio.ctx && state.audio.ctx.state === 'suspended') {
      state.audio.ctx.resume();
    }
  } else {
    powerBtn.classList.remove('on');
    powerLabel.textContent = 'OFF';
    stopRadio();
    $('radioChannelName').textContent = '— POWER OFF —';
    $('radioChannelFreq').textContent = '— — —';
    
    document.querySelectorAll('.station-item').forEach(el => el.classList.remove('active'));
    state.current.radio = null;
  }
}

function setVolume(device, value) {
  state.volume[device] = value;
  if (state.audio.masterGain) {
    state.audio.masterGain.gain.setTargetAtTime(value / 100, state.audio.ctx.currentTime, 0.1);
  }
  updateVolumeUI();
}

function updateVolumeUI() {
  const slider = $('volumeSlider');
  const value = $('volumeValue');
  if (slider) slider.value = state.volume.radio;
  if (value) value.textContent = state.volume.radio + '%';
}

function setEq(values) {
  EQ_FREQUENCIES.forEach((freq, i) => {
    state.eq[freq] = values[i] || 0;
  });
  updateEqUI();
  updateEqAudio();
  saveEqSettings();
}

function updateEqUI() {
  EQ_FREQUENCIES.forEach(freq => {
    const slider = document.querySelector('.eq-slider[data-band="' + freq + '"]');
    const valEl = document.querySelector('.eq-slider[data-band="' + freq + '"]').parentElement.querySelector('.eq-val');
    if (slider) {
      slider.value = state.eq[freq] || 0;
    }
    if (valEl) {
      valEl.textContent = (state.eq[freq] >= 0 ? '+' : '') + (state.eq[freq] || 0);
    }
  });
  
  updateEqPresetBtnState();
}

function updateEqAudio() {
  if (state.audio.ctx && state.audio.eqFilters) {
    EQ_FREQUENCIES.forEach((freq, i) => {
      const gain = state.eq[freq] || 0;
      if (state.audio.eqFilters[i]) {
        state.audio.eqFilters[i].gain.setTargetAtTime(gain, state.audio.ctx.currentTime, 0.1);
      }
    });
  }
}

function updateEqPresetBtnState() {
  const currentValues = EQ_FREQUENCIES.map(freq => state.eq[freq] || 0);
  let matchedPreset = null;
  
  for (const [key, presetValues] of Object.entries(EQ_PRESETS)) {
    if (currentValues.length === presetValues.length &&
        currentValues.every((val, i) => val === presetValues[i])) {
      matchedPreset = key;
      break;
    }
  }
  
  document.querySelectorAll('.eq-preset-btn').forEach(btn => {
    const isActive = matchedPreset && btn.dataset.eq === matchedPreset;
    btn.classList.toggle('active', isActive);
  });
}

function saveEqSettings() {
  try {
    const eqValues = EQ_FREQUENCIES.map(freq => state.eq[freq] || 0);
    localStorage.setItem('radio_eq_settings', JSON.stringify(eqValues));
  } catch (e) {}
}

function loadEqSettings() {
  try {
    const stored = localStorage.getItem('radio_eq_settings');
    if (stored) {
      const values = JSON.parse(stored);
      if (Array.isArray(values)) {
        EQ_FREQUENCIES.forEach((freq, i) => {
          state.eq[freq] = values[i] || 0;
        });
      }
    }
  } catch (e) {}
}

let rafId = null;
function startVisualizer() {
  if (rafId) cancelAnimationFrame(rafId);
  animateVisualizer();
}

function stopVisualizer() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  const bars = document.querySelectorAll('.v-bar');
  bars.forEach(bar => bar.style.height = '4px');
}

function animateVisualizer() {
  const bars = document.querySelectorAll('.v-bar');
  bars.forEach(bar => {
    const height = Math.random() * 100;
    bar.style.height = height + '%';
  });
  rafId = requestAnimationFrame(animateVisualizer);
}

function toast(msg, isError = false) {
  const toastEl = document.createElement('div');
  toastEl.className = 'toast' + (isError ? ' toast-error' : '');
  toastEl.textContent = msg;
  document.body.appendChild(toastEl);
  
  setTimeout(() => {
    toastEl.classList.add('fade-out');
    setTimeout(() => toastEl.remove(), 300);
  }, 2000);
}

function bindEvents() {
  $('powerBtn').addEventListener('click', () => togglePower('radio'));
  
  $('volumeSlider').addEventListener('input', (e) => {
    setVolume('radio', parseInt(e.target.value));
  });
  
  $('searchInput').addEventListener('input', (e) => {
    renderStationList(e.target.value);
  });
  
  document.querySelectorAll('.eq-slider').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const freq = parseInt(e.target.dataset.band);
      const gain = parseInt(e.target.value);
      state.eq[freq] = gain;
      updateEqAudio();
      
      const valEl = e.target.parentElement.querySelector('.eq-val');
      if (valEl) {
        valEl.textContent = (gain >= 0 ? '+' : '') + gain;
      }
    });
    
    slider.addEventListener('change', () => {
      saveEqSettings();
      updateEqPresetBtnState();
    });
  });
  
  document.querySelectorAll('.eq-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = EQ_PRESETS[btn.dataset.eq];
      if (preset) {
        setEq(preset);
      }
    });
  });
  
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.power.radio && state.playing.radio) {
      stopRadio();
      toast('已暂停播放（应用进入后台）');
    }
  });
  
  window.addEventListener('beforeunload', () => {
    stopRadio();
    if (state.audio.ctx) {
      state.audio.ctx.close();
    }
  });
}

window.selectChannel = selectChannel;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
