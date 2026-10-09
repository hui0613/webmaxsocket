/**
 * Class representing a user.
 */
export class User {
  id: any;
  firstname: any;
  lastname: any;
  username: any;
  phone: any;
  avatar: any;
  photoId: any;
  status: any;
  bio: any;
  rawData: any;

  constructor(data: any) {
    this.id = data.id || data.userId || data.contactId || null;
    this.firstname = data.firstname || data.firstName || data.first_name || '';
    this.lastname = data.lastname || data.lastName || data.last_name || '';
    this.username = data.username || data.nick || null;
    this.phone = data.phone || null;
    this.avatar = data.avatar || data.baseUrl || data.baseRawUrl || null;
    this.photoId = data.photoId || null;
    this.status = data.status || 'online';
    this.bio = data.bio || data.description || '';
    this.rawData = data;
  }

  /**
   * Returns the full name of the user.
   */
  get fullname(): string {
    return `${this.firstname} ${this.lastname}`.trim();
  }

  /**
   * Returns a string representation of the user.
   */
  toString(): string {
    return `User(id=${this.id}, name=${this.fullname})`;
  }

  /**
   * Returns a JSON representation.
   */
  toJSON(): any {
    return {
      id: this.id,
      firstname: this.firstname,
      lastname: this.lastname,
      username: this.username,
      phone: this.phone,
      avatar: this.avatar,
      photoId: this.photoId,
      status: this.status,
      bio: this.bio
    };
  }
}
