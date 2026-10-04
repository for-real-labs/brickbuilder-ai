"""
LDraw object packer - Python version

Converts the packLDrawModel.mjs Node.js script to Python for use in server.py
"""

import os
import sys
import zipfile
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional, Tuple


class LDrawPacker:
    def __init__(self, ldraw_path: Optional[str] = None):
        """Initialize the LDraw packer with LDraw library path"""
        if ldraw_path is None:
            # Try multiple common LDraw locations
            home_dir = os.path.expanduser("~")
            possible_paths = [
                os.path.join(home_dir, "ldraw"),
                "/root/ldraw",  # Explicit container path
                "/usr/share/ldraw",
                "/opt/ldraw",
                "/app/ldraw",
                "./ldraw"
            ]
            
            ldraw_path = None
            for path in possible_paths:
                materials_file = os.path.join(path, "LDConfig.ldr")
                if os.path.exists(materials_file):
                    ldraw_path = path
                    print(f"Found LDraw library at: {ldraw_path}")
                    break
            
            if ldraw_path is None:
                # Try to automatically download LDraw to the home directory
                print("🔍 LDraw library not found, attempting to download...")
                download_parent = Path(home_dir)
                if self.download_ldraw_library(download_parent):
                    ldraw_path = str(download_parent / "ldraw")
                else:
                    # Fall back to first option for error messages
                    ldraw_path = possible_paths[0]
        
        self.ldraw_path = Path(ldraw_path)
        self.materials_file_name = "LDConfig.ldr"
        
        # Storage for parsed objects
        self.objects_paths: List[str] = []
        self.objects_contents: List[str] = []
        self.path_map: Dict[str, str] = {}
        self.list_of_not_found: List[str] = []
    
    def download_ldraw_library(self, install_path: str) -> bool:
        """
        Download and install the LDraw library
        
        Args:
            install_path: Path where to install the LDraw library
            
        Returns:
            True if successful, False otherwise
        """
        try:
            install_path = Path(install_path)
            install_path.mkdir(parents=True, exist_ok=True)
            
            ldraw_url = "https://library.ldraw.org/library/updates/complete.zip"
            zip_path = install_path / "complete.zip"
            
            print(f"📥 Downloading LDraw library from {ldraw_url}...")
            
            # Use proper User-Agent header to avoid 403 Forbidden
            headers = {
                'User-Agent': 'Mozilla/5.0 (compatible; BrickAI/1.0; +https://brickai.app)'
            }
            request = urllib.request.Request(ldraw_url, headers=headers)
            
            with urllib.request.urlopen(request) as response:
                with open(zip_path, 'wb') as out_file:
                    out_file.write(response.read())
            
            print(f"📦 Extracting LDraw library to {install_path}...")
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(install_path)
            
            # Clean up zip file
            zip_path.unlink()
            
            # Verify installation
            materials_file = install_path / "ldraw" / "LDConfig.ldr"
            if materials_file.exists():
                print(f"✅ LDraw library successfully installed at {install_path / 'ldraw'}")
                return True
            else:
                print(f"❌ LDraw installation verification failed - LDConfig.ldr not found")
                return False
                
        except Exception as e:
            print(f"❌ Failed to download LDraw library: {e}")
            return False
    
    def pack_ldraw_model(self, file_name: str) -> str:
        """
        Pack an LDraw model file with all its dependencies
        
        Args:
            file_name: Path to the LDraw model file to pack
            
        Returns:
            Path to the packed .mpd file
            
        Raises:
            FileNotFoundError: If materials file or required parts are not found
            Exception: If packing fails
        """
        # Reset state
        self.objects_paths.clear()
        self.objects_contents.clear()
        self.path_map.clear()
        self.list_of_not_found.clear()
        
        # Load materials file
        materials_file_path = self.ldraw_path / self.materials_file_name
        print(f'Loading materials file "{materials_file_path}"...')
        
        try:
            with open(materials_file_path, 'r', encoding='utf-8') as f:
                materials_content = f.read()
        except FileNotFoundError:
            error_msg = f"LDraw library not found. Checked: {materials_file_path}\n"
            error_msg += "Please ensure the LDraw library is installed. Common locations:\n"
            error_msg += "  - ~/ldraw/\n"
            error_msg += "  - /usr/share/ldraw/\n"
            error_msg += "  - /opt/ldraw/\n"
            error_msg += "  - /app/ldraw/\n"
            error_msg += "Download from: https://www.ldraw.org/article/104.html"
            raise FileNotFoundError(error_msg)
        
        print(f'Packing "{file_name}"...')
        
        # Parse object tree
        self.parse_object(file_name, is_root=True)
        
        # Check if previously files not found are found now
        # (if so, probably they were already embedded)
        some_not_found = False
        for not_found_file in self.list_of_not_found:
            if not_found_file not in self.path_map:
                some_not_found = True
                print(f'Error: File object not found: "{not_found_file}".')
        
        if some_not_found:
            raise Exception("Some files were not found, aborting.")
        
        # Obtain packed content
        packed_content = ''
        for i in range(len(self.objects_paths) - 1, -1, -1):
            packed_content += self.objects_contents[i]
        # Three's LDraw loader treats any preamble before the first FILE as an
        # anonymous root. Put colors inside an explicit MPD root, so hierarchy
        # is rendered instead of leaving an empty configuration-only model.
        if packed_content.startswith('0 FILE '):
            header, _, body = packed_content.partition('\n')
            packed_content = header + '\n' + materials_content + '\n' + body
        else:
            packed_content = materials_content + '\n' + packed_content
        
        packed_content += '\n'
        
        # Save output file
        out_path = file_name + '_Packed.mpd'
        print(f'Writing "{out_path}"...')
        
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(packed_content)
        
        print('Done.')
        return out_path
    
    def parse_object(self, file_name: str, is_root: bool = False) -> Optional[str]:
        """
        Parse an LDraw object file and its dependencies
        
        Args:
            file_name: Name of the file to parse
            is_root: Whether this is the root file
            
        Returns:
            Object path if found, None if not found
        """
        # print(f'Adding "{file_name}".')
        
        if not is_root:
            reference = file_name.replace('\\', '/')
            if Path(reference).is_absolute() or '..' in Path(reference).parts or '\0' in reference:
                raise ValueError("LDraw dependency must stay inside the parts library")
        original_file_name = file_name
        prefix = ''
        object_content = None
        
        # For root files, try to read directly from the given path first
        if is_root:
            try:
                with open(file_name, 'r', encoding='utf-8') as f:
                    object_content = f.read()
                print(f'Successfully read root file from: {file_name}')
            except (FileNotFoundError, OSError):
                print('Could not read root file directly, trying LDraw structure...')
        
        # If we haven't read the content yet, try the LDraw directory structure
        if object_content is None:
            for attempt in range(2):
                if attempt == 1:
                    file_name = file_name.lower()
                
                prefix = ''
                
                if file_name.startswith('48/'):
                    prefix = 'p/'
                elif file_name.startswith('s/'):
                    prefix = 'parts/'
                
                absolute_object_path = self.ldraw_path / file_name
                
                # Try different path combinations
                search_paths = [
                    absolute_object_path,
                    self.ldraw_path / 'parts' / file_name,
                    self.ldraw_path / 'p' / file_name,
                    self.ldraw_path / 'models' / file_name
                ]
                
                search_prefixes = ['', 'parts/', 'p/', 'models/']
                
                for search_path, search_prefix in zip(search_paths, search_prefixes):
                    try:
                        with open(search_path, 'r', encoding='utf-8') as f:
                            object_content = f.read()
                        prefix = search_prefix
                        break
                    except (FileNotFoundError, OSError):
                        continue
                
                if object_content is not None:
                    break
                
                if attempt == 1:
                    # The file has not been found, add to list of not found
                    self.list_of_not_found.append(original_file_name)
        
        object_path = (prefix + file_name).strip().replace('\\', '/')
        
        if object_content is None:
            # File was not found, but could be a referenced embedded file.
            return None
        
        # Normalize line endings
        if '\r\n' in object_content:
            object_content = object_content.replace('\r\n', '\n')
        
        processed_object_content = '' if is_root else f'0 FILE {object_path}\n'
        
        lines = object_content.split('\n')
        # Resolve MPD assemblies before walking placements, including forward
        # references. Keep their original namespace and root FILE directive.
        for embedded in lines:
            if embedded.strip().startswith('0 FILE '):
                name = embedded.strip()[7:].strip().replace('\\', '/')
                if name:
                    self.path_map[name] = name
                    self.path_map[name.lower()] = name
        
        for i, line in enumerate(lines):
            line_length = len(line)
            
            # Skip spaces/tabs
            char_index = 0
            while char_index < line_length and line[char_index] in ' \t':
                char_index += 1
            
            line = line[char_index:]
            line_length = len(line)
            char_index = 0
            
            if line.startswith('0 FILE '):
                if i == 0 and not is_root:
                    # Library parts already have the wrapper added above.
                    continue
                
                # Embedded object was found, add to path map
                subobject_file_name = line[7:].strip().replace('\\', '/')
                
                if subobject_file_name:
                    # Find name in path cache
                    if subobject_file_name not in self.path_map:
                        self.path_map[subobject_file_name] = subobject_file_name
            
            if line.startswith('1 '):
                # Subobject, add it
                char_index = 2
                
                # Skip material, position and transform (13 tokens)
                token_count = 0
                while token_count < 13 and char_index < line_length:
                    # Skip token
                    while char_index < line_length and line[char_index] not in ' \t':
                        char_index += 1
                    
                    # Skip spaces/tabs
                    while char_index < line_length and line[char_index] in ' \t':
                        char_index += 1
                    
                    token_count += 1
                
                subobject_file_name = line[char_index:].strip().replace('\\', '/')
                
                if subobject_file_name:
                    # Find name in path cache
                    subobject_path = self.path_map.get(subobject_file_name) or self.path_map.get(subobject_file_name.lower())
                    
                    if subobject_path is None:
                        # Add new object
                        subobject_path = self.parse_object(subobject_file_name)
                    
                    self.path_map[subobject_file_name] = subobject_path if subobject_path else subobject_file_name
                    
                    processed_object_content += line[:char_index] + self.path_map[subobject_file_name] + '\n'
            else:
                processed_object_content += line + '\n'
        
        if object_path not in self.objects_paths:
            self.objects_paths.append(object_path)
            self.objects_contents.append(processed_object_content)
        
        return object_path


def pack_ldraw_model_function(file_name: str, ldraw_path: Optional[str] = None) -> str:
    """
    Convenience function to pack an LDraw model
    
    Args:
        file_name: Path to the LDraw model file to pack
        ldraw_path: Path to LDraw library (defaults to ~/ldraw)
        
    Returns:
        Path to the packed .mpd file
    """
    packer = LDrawPacker(ldraw_path)
    return packer.pack_ldraw_model(file_name)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print('Usage: python pack_ldraw_model.py <modelFilePath>')
        sys.exit(0)
    
    file_name = sys.argv[1]
    
    try:
        packed_file = pack_ldraw_model_function(file_name)
        print(f"Successfully packed to: {packed_file}")
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
