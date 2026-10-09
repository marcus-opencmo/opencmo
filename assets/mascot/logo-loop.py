import bpy,math
from mathutils import Vector
from pathlib import Path
out=Path('/home/marcus/code/opencmo/assets/mascot');s=bpy.context.scene
s.frame_set(1);s.name='OpenCMO Logo Loop'
root=s.objects['Motion Root'];body=s.objects['Body Bounce']
arms={i:s.objects['Arm Swing '+str(i)] for i in [-1,1]};legs={i:s.objects['Leg Swing '+str(i)] for i in [-1,1]}
elbows={i:s.objects['Sprint Elbow '+str(i)] for i in [-1,1]};knees={i:s.objects['Sprint Knee '+str(i)] for i in [-1,1]}
for ob in s.objects:ob.animation_data_clear()
root.location=(0,0,0);root.rotation_euler=(0,0,0);body.location=(0,0,1.9);body.rotation_euler=(0,0,0)
for ob in [*arms.values(),*legs.values(),*elbows.values(),*knees.values()]:ob.rotation_euler=(0,0,0)
bpy.context.view_layer.update()
# Miệng mở nhỏ cho nhịp thở mệt, cùng chất liệu khuôn mặt.
bpy.ops.mesh.primitive_uv_sphere_add(segments=20,ring_count=12,location=(0,-.553,3.17))
mouth=bpy.context.object;mouth.name='Panting mouth';mouth.scale=(.075,.035,.095);mouth.data.materials.append(s.objects['Eye'].data.materials[0])
for p in mouth.data.polygons:p.use_smooth=True
bpy.context.view_layer.update();w=mouth.matrix_world.copy();mouth.parent=body;mouth.matrix_world=w
mouthbase=mouth.scale.copy();smile=s.objects['Smile'];smilebase=smile.scale.copy()
eyes=[s.objects['Eye'],s.objects['Eye.001']];eyebase=[ob.scale.copy() for ob in eyes]
def smooth(v):v=max(0,min(1,v));return v*v*(3-2*v)
def idle(t):return [0,.028*math.sin(math.pi*t)**3,0,0,0,0,0,0]
# pose: độ chúi, lắc ngang, tay trái/phải, khuỷu, chân trái/phải, gối nền.
def blend(a,b,w):return [x*(1-w)+y*w for x,y in zip(a,b)]
def run(t):
 p=6*math.pi*(t-1.9);swing=math.sin(p)
 return [.40,.055*swing,swing,-swing,-1.15,-swing-.25,swing-.25,.25]
def tired(t):return [.52+.035*math.sin((t-4.4)*5*math.pi),0,-.40,-.40,-.50,-.40,-.40,.12]
feet=[o for o in s.objects if o.name.startswith('Foot keycap')]
s.render.fps=24;s.frame_start=1;s.frame_end=193
for f in range(1,194):
 t=(f-1)/24;fatigue=0;running=0
 if t<1.5:pose=idle(t)
 elif t<1.9:pose=blend(idle(1.5),run(1.9),smooth((t-1.5)/.4))
 elif t<3.9:pose=run(t);running=1
 elif t<4.4:
  w=smooth((t-3.9)/.5);pose=blend(run(3.9),tired(4.4),w);fatigue=w
 elif t<6.7:pose=tired(t);fatigue=1
 else:
  w=smooth((t-6.7)/1.3);pose=blend(tired(6.7),idle(0),w);fatigue=1-w
 body.location=(0,0,1.9);body.rotation_euler=(pose[0],pose[1],pose[1]*.5)
 for side,index in [(-1,2),(1,3)]:
  arms[side].rotation_euler.x=pose[index]
  elbows[side].rotation_euler.x=pose[4]
  legs[side].rotation_euler.x=pose[index+3]
  swing=math.sin(6*math.pi*(t-1.9)+(0 if side<0 else math.pi))
  knees[side].rotation_euler.x=pose[7]+running*1.15*max(0,-swing)
 # Đặt chân thấp nhất sát mặt đất; khi chạy có một khoảng bay ngắn.
 root.location=(0,0,0);bpy.context.view_layer.update()
 lowest=min((ob.matrix_world@Vector(c)).z for ob in feet for c in ob.bound_box)
 root.location.z=-lowest+running*.06*abs(math.sin(6*math.pi*(t-1.9)))
 root.keyframe_insert('location',frame=f)
 for ob in [body,*arms.values(),*legs.values(),*elbows.values(),*knees.values()]:ob.keyframe_insert('rotation_euler',frame=f)
 mouth.scale=mouthbase*max(.001,fatigue)*(1+.18*math.sin((t-4.4)*5*math.pi))
 smile.scale=smilebase*max(.001,1-fatigue)
 mouth.keyframe_insert('scale',frame=f);smile.keyframe_insert('scale',frame=f)
 for ob,base in zip(eyes,eyebase):
  ob.scale=base.copy();ob.scale.z*=1-.35*fatigue;ob.keyframe_insert('scale',frame=f)
# Khớp chính xác scale miệng ở đầu/cuối, kể cả phần bị thu nhỏ.
for ob in [mouth,smile,*eyes]:
 s.frame_set(1);first=ob.scale.copy();s.frame_set(193);ob.scale=first;ob.keyframe_insert('scale',frame=193)
s.frame_set(1)
bpy.ops.object.select_all(action='DESELECT')
for ob in s.objects:
 if ob.type in {'MESH','CURVE','EMPTY'} and ob.name not in {'Studio floor','Cube'}:ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(out/'opencmo-logo-loop.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_apply=True,export_animations=True,export_animation_mode='SCENE',export_anim_scene_split_object=False,export_force_sampling=True,export_anim_slide_to_zero=True)
s.objects['Studio floor'].hide_render=True
cam=s.camera;cam.animation_data_clear();cam.location=(6,-10,4.7);cam.rotation_euler=(Vector((0,-.15,2))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=5.6
s.render.film_transparent=True;s.render.image_settings.color_mode='RGBA';s.render.image_settings.file_format='PNG'
s.render.resolution_x=480;s.render.resolution_y=480;s.render.resolution_percentage=100;s.cycles.samples=4
s.render.filepath=str(out/'logo-frames/frame-')
bpy.ops.wm.save_as_mainfile(filepath=str(out/'opencmo-logo-loop.blend'))
print('LOGO_LOOP_SAVED: idle, sprint, stop, pant, recover; 8 seconds')
