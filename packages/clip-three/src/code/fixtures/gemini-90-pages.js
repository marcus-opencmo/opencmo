  const stackGroup = new THREE.Group();
  stackGroup.name = "Paper Stack";
  stage.root.add(stackGroup);

  const paperGeo = new THREE.BoxGeometry(4.2, 0.05, 5.94);
  const paperMat = kit.glossy(0xffffff, { roughness: 0.3, emissive: 0.1 }); 

  const paperCount = 90;
  const pages = [];

  for (let i = 0; i < paperCount; i++) {
    const mesh = new THREE.Mesh(paperGeo, paperMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    
    stackGroup.add(mesh);
    pages.push({
      mesh,
      targetRotY: (stage.random() - 0.5) * 0.3, 
      targetX: (stage.random() - 0.5) * 0.2,
      targetZ: (stage.random() - 0.5) * 0.2,
    });
  }

  const label90 = kit.label("90 PAGES", { size: 4, glow: true, font: 'display' });
  stage.root.add(label90);

  const label72 = kit.label("72 HOURS", { size: 3, color: stage.palette.colors[1], font: 'display' });
  stage.root.add(label72);

  return (t) => {
    const pileDuration = 2.0;
    
    for (let i = 0; i < paperCount; i++) {
      const pData = pages[i];
      const p = kit.phase(t, i * (pileDuration / paperCount), 0.3); 
      const ease = kit.easeOutCubic(p);
      
      const startY = 25;
      const targetY = i * 0.055;
      
      pData.mesh.position.y = startY - (startY - targetY) * ease;
      pData.mesh.position.x = pData.targetX * ease;
      pData.mesh.position.z = pData.targetZ * ease;
      
      if (p < 1) {
        pData.mesh.rotation.x = p * Math.PI * 2;
        pData.mesh.rotation.z = p * Math.PI * 2;
        pData.mesh.rotation.y = pData.targetRotY * ease;
      } else {
        pData.mesh.rotation.set(0, pData.targetRotY, 0);
      }
      
      pData.mesh.visible = p > 0;
    }
    
    const p90 = kit.phase(t, 1.0, 0.4);
    label90.position.set(0, 10 + p90 * 2, 0);
    label90.scale.setScalar(kit.easeOutBack(p90));
    
    const p72 = kit.phase(t, 2.0, 0.4);
    label72.position.set(0, 6 + p72 * 1.5, 1);
    label72.scale.setScalar(kit.easeOutBack(p72));

    kit.frame({ 
      yaw: 15 + t * 2, 
      pitch: 12, 
      padding: 0.8,
      push: t / 4 
    });
  };
