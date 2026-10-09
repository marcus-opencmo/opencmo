import bpy,math
from pathlib import Path
from mathutils import Vector
out=Path('/home/marcus/code/opencmo/assets/mascot');s=bpy.context.scene;s.frame_set(1);s.name='Loading Sprint'
root=s.objects['Motion Root'];body=s.objects['Body Bounce']
arms={i:s.objects['Arm Swing '+str(i)] for i in [-1,1]};legs={i:s.objects['Leg Swing '+str(i)] for i in [-1,1]}
elbows={i:s.objects['Sprint Elbow '+str(i)] for i in [-1,1]};knees={i:s.objects['Sprint Knee '+str(i)] for i in [-1,1]}
for ob in list(s.objects):
 ob.animation_data_clear()
 if ob.name.startswith(('Panting mouth','Sweat')):bpy.data.objects.remove(ob,do_unlink=True)
root.location=(0,0,0);body.location=(0,0,1.9);body.rotation_euler=(0,0,0)
for ob in [*arms.values(),*legs.values(),*elbows.values(),*knees.values()]:ob.rotation_euler=(0,0,0)
s.objects['Smile'].scale=(1,1,1)
for name in ['Eye','Eye.001']:s.objects[name].scale=(.095,.06,.13)
bpy.context.view_layer.update()
mat=bpy.data.materials.new('Sweat pale aqua');mat.diffuse_color=(.25,.68,.84,1);mat.use_nodes=True
shader=mat.node_tree.nodes.get('Principled BSDF');shader.inputs['Base Color'].default_value=(.25,.68,.84,1);shader.inputs['Roughness'].default_value=.18
# Giọt nước nổi trên mặt phím, đầu nhọn và đáy tròn.
drops=[]
for k,x in enumerate([.57,.83,-.78]):
 verts=[];faces=[];rings=12;segments=20
 for i in range(rings+1):
  u=i/rings;r=.115*math.sin(math.pi*u)*(1.35-.85*u)
  for j in range(segments):
   a=2*math.pi*j/segments;verts.append((r*math.cos(a),r*.42*math.sin(a),-.12+.34*u))
 for i in range(rings):
  for j in range(segments):
   a=i*segments+j;b=i*segments+(j+1)%segments;faces.append((a,b,b+segments,a+segments))
 mesh=bpy.data.meshes.new('Sweat droplet');mesh.from_pydata(verts,[],faces);mesh.update()
 ob=bpy.data.objects.new('Sweat '+str(k),mesh);s.collection.objects.link(ob);ob.data.materials.append(mat)
 for p in mesh.polygons:p.use_smooth=True
 ob.location=(x,-.55,3.82 if k!=1 else 3.64);bpy.context.view_layer.update();w=ob.matrix_world.copy();ob.parent=body;ob.matrix_world=w
 drops.append((ob,ob.location.copy()))
s.render.fps=30;s.frame_start=1;s.frame_end=31
feet=[o for o in s.objects if o.name.startswith('Foot keycap')]
for f in range(1,32):
 t=(f-1)/30;p=6*math.pi*t
 body.rotation_euler=(.46,.045*math.sin(p),.05*math.sin(p))
 for side in [-1,1]:
  q=p+(0 if side<0 else math.pi);stride=math.sin(q)
  arms[side].rotation_euler.x=1.05*stride
  elbows[side].rotation_euler.x=-1.12+.15*stride
  legs[side].rotation_euler.x=-1.04*stride-.26
  knees[side].rotation_euler.x=.22+1.20*max(0,-stride)
 root.location=(0,0,0);bpy.context.view_layer.update()
 lowest=min((ob.matrix_world@Vector(c)).z for ob in feet for c in ob.bound_box)
 root.location.z=-lowest+.055*abs(math.sin(p))
 root.keyframe_insert('location',frame=f)
 for ob in [body,*arms.values(),*elbows.values(),*legs.values(),*knees.values()]:ob.keyframe_insert('rotation_euler',frame=f)
 for k,(ob,base) in enumerate(drops):
  q=2*math.pi*t+k*2*math.pi/3
  ob.location=base+Vector((.015*math.sin(q),0,.055*math.cos(q)))
  ob.scale=(1,1,1+.12*math.sin(q));ob.keyframe_insert('location',frame=f);ob.keyframe_insert('scale',frame=f)
s.frame_set(1)
bpy.ops.object.select_all(action='DESELECT')
for ob in s.objects:
 if ob.type in {'MESH','CURVE','EMPTY'} and ob.name not in {'Studio floor','Cube'}:ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(out/'opencmo-loading.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_apply=True,export_animations=True,export_animation_mode='SCENE',export_anim_scene_split_object=False,export_force_sampling=True,export_anim_slide_to_zero=True)
s.objects['Studio floor'].hide_render=True
cam=s.camera;cam.location=(6,-10,4.7);cam.rotation_euler=(Vector((0,-.18,2))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=5.2
s.render.film_transparent=True;s.render.image_settings.color_mode='RGBA';s.render.image_settings.file_format='PNG'
s.render.resolution_x=512;s.render.resolution_y=512;s.render.resolution_percentage=100;s.cycles.samples=16;s.cycles.use_denoising=True
s.render.filepath=str(out/'loading-frames/frame-')
bpy.ops.wm.save_as_mainfile(filepath=str(out/'opencmo-loading.blend'))
print('LOADING_SPRINT_SAVED')
