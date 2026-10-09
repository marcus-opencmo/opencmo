import bpy,math
from mathutils import Vector
from pathlib import Path
out=Path('/home/marcus/code/opencmo/assets/mascot');s=bpy.context.scene;s.name='Track Sprint Left to Right'
root=s.objects['Motion Root'];body=s.objects['Body Bounce']
# Giữ nhịp chạy đã duyệt, kéo dài thành ba giây với hướng ngang cố định.
s.frame_set(1)
drops=[(s.objects['Sweat '+str(k)],s.objects['Sweat '+str(k)].location.copy()) for k in range(3)]
for ob in s.objects:ob.animation_data_clear()
root.rotation_euler.z=math.radians(55)
feet=[o for o in s.objects if o.name.startswith('Foot keycap')]
s.render.fps=30;s.frame_start=1;s.frame_end=91
for f in range(1,92):
 t=(f-1)/30;p=6*math.pi*t
 body.rotation_euler=(.46,.045*math.sin(p),.05*math.sin(p))
 for side in [-1,1]:
  stride=math.sin(p+(0 if side<0 else math.pi))
  for name,angle in [('Arm Swing ',1.05*stride),('Sprint Elbow ',-1.12+.15*stride),('Leg Swing ',-1.04*stride-.26),('Sprint Knee ',.22+1.20*max(0,-stride))]:
   ob=s.objects[name+str(side)];ob.rotation_euler.x=angle;ob.keyframe_insert('rotation_euler',frame=f)
 body.keyframe_insert('rotation_euler',frame=f)
 root.location=(-12+8*t,-1,0);bpy.context.view_layer.update()
 low=min((ob.matrix_world@Vector(c)).z for ob in feet for c in ob.bound_box)
 root.location.z=-low+.055*abs(math.sin(p))+.035;root.keyframe_insert('location',frame=f)
 for k,(ob,base) in enumerate(drops):
  q=2*math.pi*t+k*2*math.pi/3
  ob.location=base+Vector((.015*math.sin(q),0,.05*(math.cos(q)-math.cos(k*2*math.pi/3))))
  ob.scale=(1,1,1+.12*math.sin(q));ob.keyframe_insert('location',frame=f);ob.keyframe_insert('scale',frame=f)
def material(name,color):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True;m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(*color,1);m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.8;return m
def box(name,loc,scale,mat):
 bpy.ops.mesh.primitive_cube_add(size=1,location=loc);ob=bpy.context.object;ob.name=name;ob.scale=scale;ob.data.materials.append(mat);return ob
track=material('Track terracotta',(.61,.26,.18));white=material('Lane ivory',(.96,.91,.80));green=material('Infield sage',(.30,.46,.36));black=material('Finish charcoal',(.035,.055,.055))
box('Track surface',(0,0,-.12),(45,6,.2),track)
box('Infield',(0,8,-.14),(45,10,.2),green)
box('Track foreground',(0,-9,-.14),(45,12,.2),green)
for y in [-3,-1.95,.0,1.95,3]:box('Lane line',(0,y,.006),(45,.055,.012),white)
# Vạch đích caro nằm ngang qua các làn, ở phía phải khung hình.
for i in range(2):
 for j in range(16):box('Finish checker',(4.7+i*.22,-2.85+j*.38,.02),(.22,.38,.022),white if (i+j)%2==0 else black)
for x in [-7,-3,1,5,9]:
 box('Track marker',(x,2.7,.1),(.09,.2,.18),white)
box('Finish sign',(5.0,3.5,2.4),(2.45,.16,.8),black)
for x in [4.1,5.9]:box('Sign post',(x,3.5,1.0),(.06,.06,2),white)
bpy.ops.object.text_add(location=(5,3.39,2.16),rotation=(math.pi/2,0,0));label=bpy.context.object;label.name='FINISH label';label.data.body='FINISH';label.data.align_x='CENTER';label.data.size=.47;label.data.extrude=.003;label.data.materials.append(white)
# Đèn phủ cả đường chạy, tránh nhân vật tối dần ở hai mép.
for ob in s.objects:
 if ob.type=='LIGHT':ob.data.size=9;ob.data.energy*=1.35
floor=s.objects['Studio floor'];floor.hide_render=True
cam=s.camera;cam.location=(0,-22,12);cam.rotation_euler=(Vector((0,0,1.1))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=18
s.render.film_transparent=False;s.render.resolution_x=720;s.render.resolution_y=360;s.cycles.samples=8
s.render.image_settings.color_mode='RGB';s.render.filepath=str(out/'track-frames/frame-')
s.frame_set(1)
bpy.ops.object.select_all(action='DESELECT')
for ob in s.objects:
 if ob.type in {'MESH','CURVE','EMPTY','FONT'} and ob.name not in {'Studio floor','Cube'}:ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(out/'opencmo-track-sprint.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_apply=True,export_animations=True,export_animation_mode='SCENE',export_anim_scene_split_object=False,export_force_sampling=True,export_anim_slide_to_zero=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out/'opencmo-track-sprint.blend'))
print('TRACK_SPRINT_SAVED')
