import os
from PIL import Image, ImageDraw, ImageFont

def draw_icon(size):
    # Create a rounded rectangle background
    img = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    draw = ImageDraw.Draw(img)
    
    # Modern standard color: deep blue 
    bg_color = (26, 115, 232)
    border_radius = max(size // 8, 2)
    draw.rounded_rectangle([0, 0, size-1, size-1], radius=border_radius, fill=bg_color)
    
    # Let's draw something abstract yet representative: 
    # A speech bubble or two overlapping shapes, or just an 'A' for language.
    # To avoid font issues, we'll draw simple geometry.
    # Two overlapping squares/bubbles.
    
    # First shape (white)
    s1_x1, s1_y1 = size * 0.15, size * 0.15
    s1_x2, s1_y2 = size * 0.65, size * 0.65
    draw.rounded_rectangle([s1_x1, s1_y1, s1_x2, s1_y2], radius=border_radius//2, fill=(255, 255, 255))
    
    # Draw an 'A' letter inside the first shape manually to avoid font dependency
    aw, ah = (s1_x2 - s1_x1), (s1_y2 - s1_y1)
    cx, cy = s1_x1 + aw/2, s1_y1 + ah/2
    thickness = max(size // 20, 1)
    
    a_pts = [
        (cx, cy - ah*0.25),
        (cx - aw*0.2, cy + ah*0.25),
        (cx + aw*0.2, cy + ah*0.25)
    ]
    draw.line([a_pts[0], a_pts[1]], fill=bg_color, width=thickness)
    draw.line([a_pts[0], a_pts[2]], fill=bg_color, width=thickness)
    draw.line([(cx - aw*0.1, cy), (cx + aw*0.1, cy)], fill=bg_color, width=thickness)
    
    # Second shape (light blue/grey)
    s2_x1, s2_y1 = size * 0.35, size * 0.35
    s2_x2, s2_y2 = size * 0.85, size * 0.85
    draw.rounded_rectangle([s2_x1, s2_y1, s2_x2, s2_y2], radius=border_radius//2, fill=(200, 225, 255), outline=(255,255,255), width=max(size//30, 1))
    
    # Draw simple lines for text in the second shape
    lx, ly = s2_x1 + aw/2, s2_y1 + ah/2
    draw.line([(lx - aw*0.2, ly - ah*0.1), (lx + aw*0.2, ly - ah*0.1)], fill=bg_color, width=thickness)
    draw.line([(lx - aw*0.2, ly), (lx + aw*0.2, ly)], fill=bg_color, width=thickness)
    draw.line([(lx - aw*0.2, ly + ah*0.1), (lx + aw*0.2, ly + ah*0.1)], fill=bg_color, width=thickness)

    # Save
    out_path = f"assets/icons/icon{size}.png"
    img.save(out_path)
    print(f"Generated {out_path}")

os.makedirs("assets/icons", exist_ok=True)
for size in [16, 48, 128]:
    draw_icon(size)
