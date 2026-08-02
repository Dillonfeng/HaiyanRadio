window._execB64Fn = function(src){ try { (new Function(src))(); } catch(ee){ console.error(ee.message||ee); }; console.log("[AUTO] wrapper defined"); };
